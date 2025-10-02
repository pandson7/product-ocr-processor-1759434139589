"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductOcrProcessorStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3n = __importStar(require("aws-cdk-lib/aws-s3-notifications"));
class ProductOcrProcessorStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const suffix = '1759434139589';
        // S3 bucket for product images
        const imageBucket = new s3.Bucket(this, `ProductImageBucket${suffix}`, {
            bucketName: `product-images-${suffix}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // DynamoDB table for product specifications
        const specificationsTable = new dynamodb.Table(this, `ProductSpecificationsTable${suffix}`, {
            tableName: `product-specifications-${suffix}`,
            partitionKey: { name: 'image_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'processing_timestamp', type: dynamodb.AttributeType.STRING },
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });
        // IAM role for Lambda function
        const lambdaRole = new iam.Role(this, `OcrProcessorLambdaRole${suffix}`, {
            roleName: `ocr-processor-lambda-role-${suffix}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });
        // Add permissions for S3, Bedrock, and DynamoDB
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject'],
            resources: [imageBucket.arnForObjects('*')],
        }));
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0'
            ],
        }));
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:PutItem'],
            resources: [specificationsTable.tableArn],
        }));
        // Lambda function for OCR processing
        const ocrProcessorFunction = new lambda.Function(this, `OcrProcessorFunction${suffix}`, {
            functionName: `ocr-processor-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json
import boto3
import base64
import uuid
from datetime import datetime
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')
bedrock_client = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    try:
        # Parse S3 event
        for record in event['Records']:
            bucket = record['s3']['bucket']['name']
            key = record['s3']['object']['key']
            
            logger.info(f"Processing image: {bucket}/{key}")
            
            # Get image from S3
            response = s3_client.get_object(Bucket=bucket, Key=key)
            image_data = response['Body'].read()
            image_base64 = base64.b64encode(image_data).decode('utf-8')
            
            # Prepare Bedrock request
            prompt = """
            Analyze this product image and extract the following information in JSON format:
            - product_name: The name of the product
            - brand: The brand or manufacturer
            - category: Product category
            - specifications: Any technical specifications, features, or details visible
            - confidence_score: Your confidence in the extraction (0-1)
            
            Return only valid JSON without any additional text.
            """
            
            bedrock_request = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1000,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": image_base64
                                }
                            },
                            {
                                "type": "text",
                                "text": prompt
                            }
                        ]
                    }
                ]
            }
            
            # Call Bedrock
            bedrock_response = bedrock_client.invoke_model(
                modelId='global.anthropic.claude-sonnet-4-20250514-v1:0',
                body=json.dumps(bedrock_request)
            )
            
            response_body = json.loads(bedrock_response['body'].read())
            extracted_text = response_body['content'][0]['text']
            
            # Parse extracted specifications
            try:
                specifications = json.loads(extracted_text)
            except json.JSONDecodeError:
                specifications = {"error": "Failed to parse JSON", "raw_text": extracted_text}
            
            # Store in DynamoDB
            table = dynamodb.Table('product-specifications-${suffix}')
            image_id = str(uuid.uuid4())
            timestamp = datetime.utcnow().isoformat()
            
            table.put_item(
                Item={
                    'image_id': image_id,
                    'processing_timestamp': timestamp,
                    'source_bucket': bucket,
                    'source_key': key,
                    'product_specifications': specifications,
                    'processing_status': 'completed'
                }
            )
            
            logger.info(f"Successfully processed image {key} with ID {image_id}")
            
        return {
            'statusCode': 200,
            'body': json.dumps('Processing completed successfully')
        }
        
    except Exception as e:
        logger.error(f"Error processing image: {str(e)}")
        
        # Store error in DynamoDB
        try:
            table = dynamodb.Table('product-specifications-${suffix}')
            error_id = str(uuid.uuid4())
            timestamp = datetime.utcnow().isoformat()
            
            table.put_item(
                Item={
                    'image_id': error_id,
                    'processing_timestamp': timestamp,
                    'source_bucket': bucket if 'bucket' in locals() else 'unknown',
                    'source_key': key if 'key' in locals() else 'unknown',
                    'processing_status': 'failed',
                    'error_message': str(e)
                }
            )
        except:
            pass
            
        return {
            'statusCode': 500,
            'body': json.dumps(f'Error: {str(e)}')
        }
`),
            role: lambdaRole,
            timeout: cdk.Duration.minutes(5),
            memorySize: 1024,
            environment: {
                'TABLE_NAME': specificationsTable.tableName,
                'BUCKET_NAME': imageBucket.bucketName,
            },
        });
        // Add S3 event notification to trigger Lambda
        imageBucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new s3n.LambdaDestination(ocrProcessorFunction), { suffix: '.jpg' });
        imageBucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new s3n.LambdaDestination(ocrProcessorFunction), { suffix: '.jpeg' });
        imageBucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new s3n.LambdaDestination(ocrProcessorFunction), { suffix: '.png' });
        // Outputs
        new cdk.CfnOutput(this, 'ImageBucketName', {
            value: imageBucket.bucketName,
            description: 'Name of the S3 bucket for product images',
        });
        new cdk.CfnOutput(this, 'SpecificationsTableName', {
            value: specificationsTable.tableName,
            description: 'Name of the DynamoDB table for product specifications',
        });
        new cdk.CfnOutput(this, 'LambdaFunctionName', {
            value: ocrProcessorFunction.functionName,
            description: 'Name of the OCR processor Lambda function',
        });
    }
}
exports.ProductOcrProcessorStack = ProductOcrProcessorStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLWFwcC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNkay1hcHAtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFFbkMsdURBQXlDO0FBQ3pDLCtEQUFpRDtBQUNqRCxtRUFBcUQ7QUFDckQseURBQTJDO0FBQzNDLHNFQUF3RDtBQUV4RCxNQUFhLHdCQUF5QixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3JELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxNQUFNLEdBQUcsZUFBZSxDQUFDO1FBRS9CLCtCQUErQjtRQUMvQixNQUFNLFdBQVcsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLHFCQUFxQixNQUFNLEVBQUUsRUFBRTtZQUNyRSxVQUFVLEVBQUUsa0JBQWtCLE1BQU0sRUFBRTtZQUN0QyxVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFDMUMsU0FBUyxFQUFFLElBQUk7WUFDZixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsNENBQTRDO1FBQzVDLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSw2QkFBNkIsTUFBTSxFQUFFLEVBQUU7WUFDMUYsU0FBUyxFQUFFLDBCQUEwQixNQUFNLEVBQUU7WUFDN0MsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDdkUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLHNCQUFzQixFQUFFLElBQUksRUFBRSxRQUFR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LFdBQVcsQ0FBQyxvQkFBb0IsQ0FDOUIsRUFBRSxDQUFDLFNBQVMsQ0FBQyxrQkFBa0IsRUFDL0IsSUFBSSxHQUFHLENBQUMsaUJBQWlCLENBQUMsb0JBQW9CLENBQUMsRUFDL0MsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQ3BCLENBQUM7UUFFRixXQUFXLENBQUMsb0JBQW9CLENBQzlCLEVBQUUsQ0FBQyxTQUFTLENBQUMsa0JBQWtCLEVBQy9CLElBQUksR0FBRyxDQUFDLGlCQUFpQixDQUFDLG9CQUFvQixDQUFDLEVBQy9DLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxDQUNuQixDQUFDO1FBRUYsVUFBVTtRQUNWLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekMsS0FBSyxFQUFFLFdBQVcsQ0FBQyxVQUFVO1lBQzdCLFdBQVcsRUFBRSwwQ0FBMEM7U0FDeEQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUNqRCxLQUFLLEVBQUUsbUJBQW1CLENBQUMsU0FBUztZQUNwQyxXQUFXLEVBQUUsdURBQXVEO1NBQ3JFLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLG9CQUFvQixDQUFDLFlBQVk7WUFDeEMsV0FBVyxFQUFFLDJDQUEyQztTQUN6RCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE1T0QsNERBNE9DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBzM24gZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLW5vdGlmaWNhdGlvbnMnO1xuXG5leHBvcnQgY2xhc3MgUHJvZHVjdE9jclByb2Nlc3NvclN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3Qgc3VmZml4ID0gJzE3NTk0MzQxMzk1ODknO1xuXG4gICAgLy8gUzMgYnVja2V0IGZvciBwcm9kdWN0IGltYWdlc1xuICAgIGNvbnN0IGltYWdlQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBgUHJvZHVjdEltYWdlQnVja2V0JHtzdWZmaXh9YCwge1xuICAgICAgYnVja2V0TmFtZTogYHByb2R1Y3QtaW1hZ2VzLSR7c3VmZml4fWAsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICB2ZXJzaW9uZWQ6IHRydWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBEeW5hbW9EQiB0YWJsZSBmb3IgcHJvZHVjdCBzcGVjaWZpY2F0aW9uc1xuICAgIGNvbnN0IHNwZWNpZmljYXRpb25zVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgYFByb2R1Y3RTcGVjaWZpY2F0aW9uc1RhYmxlJHtzdWZmaXh9YCwge1xuICAgICAgdGFibGVOYW1lOiBgcHJvZHVjdC1zcGVjaWZpY2F0aW9ucy0ke3N1ZmZpeH1gLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdpbWFnZV9pZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdwcm9jZXNzaW5nX3RpbWVzdGFtcCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgfSk7XG5cbiAgICAvLyBJQU0gcm9sZSBmb3IgTGFtYmRhIGZ1bmN0aW9uXG4gICAgY29uc3QgbGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBgT2NyUHJvY2Vzc29yTGFtYmRhUm9sZSR7c3VmZml4fWAsIHtcbiAgICAgIHJvbGVOYW1lOiBgb2NyLXByb2Nlc3Nvci1sYW1iZGEtcm9sZS0ke3N1ZmZpeH1gLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJyksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHBlcm1pc3Npb25zIGZvciBTMywgQmVkcm9jaywgYW5kIER5bmFtb0RCXG4gICAgbGFtYmRhUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ3MzOkdldE9iamVjdCddLFxuICAgICAgcmVzb3VyY2VzOiBbaW1hZ2VCdWNrZXQuYXJuRm9yT2JqZWN0cygnKicpXSxcbiAgICB9KSk7XG5cbiAgICBsYW1iZGFSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnYmVkcm9jazpJbnZva2VNb2RlbCddLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICdhcm46YXdzOmJlZHJvY2s6KjoqOmluZmVyZW5jZS1wcm9maWxlL2dsb2JhbC5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjAnLFxuICAgICAgICAnYXJuOmF3czpiZWRyb2NrOio6OmZvdW5kYXRpb24tbW9kZWwvYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowJ1xuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICBsYW1iZGFSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnZHluYW1vZGI6UHV0SXRlbSddLFxuICAgICAgcmVzb3VyY2VzOiBbc3BlY2lmaWNhdGlvbnNUYWJsZS50YWJsZUFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9uIGZvciBPQ1IgcHJvY2Vzc2luZ1xuICAgIGNvbnN0IG9jclByb2Nlc3NvckZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgT2NyUHJvY2Vzc29yRnVuY3Rpb24ke3N1ZmZpeH1gLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGBvY3ItcHJvY2Vzc29yLSR7c3VmZml4fWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMSxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBib3RvM1xuaW1wb3J0IGJhc2U2NFxuaW1wb3J0IHV1aWRcbmZyb20gZGF0ZXRpbWUgaW1wb3J0IGRhdGV0aW1lXG5pbXBvcnQgbG9nZ2luZ1xuXG5sb2dnZXIgPSBsb2dnaW5nLmdldExvZ2dlcigpXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxuXG5zM19jbGllbnQgPSBib3RvMy5jbGllbnQoJ3MzJylcbmJlZHJvY2tfY2xpZW50ID0gYm90bzMuY2xpZW50KCdiZWRyb2NrLXJ1bnRpbWUnKVxuZHluYW1vZGIgPSBib3RvMy5yZXNvdXJjZSgnZHluYW1vZGInKVxuXG5kZWYgaGFuZGxlcihldmVudCwgY29udGV4dCk6XG4gICAgdHJ5OlxuICAgICAgICAjIFBhcnNlIFMzIGV2ZW50XG4gICAgICAgIGZvciByZWNvcmQgaW4gZXZlbnRbJ1JlY29yZHMnXTpcbiAgICAgICAgICAgIGJ1Y2tldCA9IHJlY29yZFsnczMnXVsnYnVja2V0J11bJ25hbWUnXVxuICAgICAgICAgICAga2V5ID0gcmVjb3JkWydzMyddWydvYmplY3QnXVsna2V5J11cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbG9nZ2VyLmluZm8oZlwiUHJvY2Vzc2luZyBpbWFnZToge2J1Y2tldH0ve2tleX1cIilcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgIyBHZXQgaW1hZ2UgZnJvbSBTM1xuICAgICAgICAgICAgcmVzcG9uc2UgPSBzM19jbGllbnQuZ2V0X29iamVjdChCdWNrZXQ9YnVja2V0LCBLZXk9a2V5KVxuICAgICAgICAgICAgaW1hZ2VfZGF0YSA9IHJlc3BvbnNlWydCb2R5J10ucmVhZCgpXG4gICAgICAgICAgICBpbWFnZV9iYXNlNjQgPSBiYXNlNjQuYjY0ZW5jb2RlKGltYWdlX2RhdGEpLmRlY29kZSgndXRmLTgnKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAjIFByZXBhcmUgQmVkcm9jayByZXF1ZXN0XG4gICAgICAgICAgICBwcm9tcHQgPSBcIlwiXCJcbiAgICAgICAgICAgIEFuYWx5emUgdGhpcyBwcm9kdWN0IGltYWdlIGFuZCBleHRyYWN0IHRoZSBmb2xsb3dpbmcgaW5mb3JtYXRpb24gaW4gSlNPTiBmb3JtYXQ6XG4gICAgICAgICAgICAtIHByb2R1Y3RfbmFtZTogVGhlIG5hbWUgb2YgdGhlIHByb2R1Y3RcbiAgICAgICAgICAgIC0gYnJhbmQ6IFRoZSBicmFuZCBvciBtYW51ZmFjdHVyZXJcbiAgICAgICAgICAgIC0gY2F0ZWdvcnk6IFByb2R1Y3QgY2F0ZWdvcnlcbiAgICAgICAgICAgIC0gc3BlY2lmaWNhdGlvbnM6IEFueSB0ZWNobmljYWwgc3BlY2lmaWNhdGlvbnMsIGZlYXR1cmVzLCBvciBkZXRhaWxzIHZpc2libGVcbiAgICAgICAgICAgIC0gY29uZmlkZW5jZV9zY29yZTogWW91ciBjb25maWRlbmNlIGluIHRoZSBleHRyYWN0aW9uICgwLTEpXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIFJldHVybiBvbmx5IHZhbGlkIEpTT04gd2l0aG91dCBhbnkgYWRkaXRpb25hbCB0ZXh0LlxuICAgICAgICAgICAgXCJcIlwiXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGJlZHJvY2tfcmVxdWVzdCA9IHtcbiAgICAgICAgICAgICAgICBcImFudGhyb3BpY192ZXJzaW9uXCI6IFwiYmVkcm9jay0yMDIzLTA1LTMxXCIsXG4gICAgICAgICAgICAgICAgXCJtYXhfdG9rZW5zXCI6IDEwMDAsXG4gICAgICAgICAgICAgICAgXCJtZXNzYWdlc1wiOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwicm9sZVwiOiBcInVzZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiY29udGVudFwiOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJpbWFnZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInNvdXJjZVwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJiYXNlNjRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibWVkaWFfdHlwZVwiOiBcImltYWdlL2pwZWdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiZGF0YVwiOiBpbWFnZV9iYXNlNjRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJ0ZXh0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidGV4dFwiOiBwcm9tcHRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgICMgQ2FsbCBCZWRyb2NrXG4gICAgICAgICAgICBiZWRyb2NrX3Jlc3BvbnNlID0gYmVkcm9ja19jbGllbnQuaW52b2tlX21vZGVsKFxuICAgICAgICAgICAgICAgIG1vZGVsSWQ9J2dsb2JhbC5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjAnLFxuICAgICAgICAgICAgICAgIGJvZHk9anNvbi5kdW1wcyhiZWRyb2NrX3JlcXVlc3QpXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3BvbnNlX2JvZHkgPSBqc29uLmxvYWRzKGJlZHJvY2tfcmVzcG9uc2VbJ2JvZHknXS5yZWFkKCkpXG4gICAgICAgICAgICBleHRyYWN0ZWRfdGV4dCA9IHJlc3BvbnNlX2JvZHlbJ2NvbnRlbnQnXVswXVsndGV4dCddXG4gICAgICAgICAgICBcbiAgICAgICAgICAgICMgUGFyc2UgZXh0cmFjdGVkIHNwZWNpZmljYXRpb25zXG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgc3BlY2lmaWNhdGlvbnMgPSBqc29uLmxvYWRzKGV4dHJhY3RlZF90ZXh0KVxuICAgICAgICAgICAgZXhjZXB0IGpzb24uSlNPTkRlY29kZUVycm9yOlxuICAgICAgICAgICAgICAgIHNwZWNpZmljYXRpb25zID0ge1wiZXJyb3JcIjogXCJGYWlsZWQgdG8gcGFyc2UgSlNPTlwiLCBcInJhd190ZXh0XCI6IGV4dHJhY3RlZF90ZXh0fVxuICAgICAgICAgICAgXG4gICAgICAgICAgICAjIFN0b3JlIGluIER5bmFtb0RCXG4gICAgICAgICAgICB0YWJsZSA9IGR5bmFtb2RiLlRhYmxlKCdwcm9kdWN0LXNwZWNpZmljYXRpb25zLSR7c3VmZml4fScpXG4gICAgICAgICAgICBpbWFnZV9pZCA9IHN0cih1dWlkLnV1aWQ0KCkpXG4gICAgICAgICAgICB0aW1lc3RhbXAgPSBkYXRldGltZS51dGNub3coKS5pc29mb3JtYXQoKVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB0YWJsZS5wdXRfaXRlbShcbiAgICAgICAgICAgICAgICBJdGVtPXtcbiAgICAgICAgICAgICAgICAgICAgJ2ltYWdlX2lkJzogaW1hZ2VfaWQsXG4gICAgICAgICAgICAgICAgICAgICdwcm9jZXNzaW5nX3RpbWVzdGFtcCc6IHRpbWVzdGFtcCxcbiAgICAgICAgICAgICAgICAgICAgJ3NvdXJjZV9idWNrZXQnOiBidWNrZXQsXG4gICAgICAgICAgICAgICAgICAgICdzb3VyY2Vfa2V5Jzoga2V5LFxuICAgICAgICAgICAgICAgICAgICAncHJvZHVjdF9zcGVjaWZpY2F0aW9ucyc6IHNwZWNpZmljYXRpb25zLFxuICAgICAgICAgICAgICAgICAgICAncHJvY2Vzc2luZ19zdGF0dXMnOiAnY29tcGxldGVkJ1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbG9nZ2VyLmluZm8oZlwiU3VjY2Vzc2Z1bGx5IHByb2Nlc3NlZCBpbWFnZSB7a2V5fSB3aXRoIElEIHtpbWFnZV9pZH1cIilcbiAgICAgICAgICAgIFxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiAyMDAsXG4gICAgICAgICAgICAnYm9keSc6IGpzb24uZHVtcHMoJ1Byb2Nlc3NpbmcgY29tcGxldGVkIHN1Y2Nlc3NmdWxseScpXG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBsb2dnZXIuZXJyb3IoZlwiRXJyb3IgcHJvY2Vzc2luZyBpbWFnZToge3N0cihlKX1cIilcbiAgICAgICAgXG4gICAgICAgICMgU3RvcmUgZXJyb3IgaW4gRHluYW1vREJcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgdGFibGUgPSBkeW5hbW9kYi5UYWJsZSgncHJvZHVjdC1zcGVjaWZpY2F0aW9ucy0ke3N1ZmZpeH0nKVxuICAgICAgICAgICAgZXJyb3JfaWQgPSBzdHIodXVpZC51dWlkNCgpKVxuICAgICAgICAgICAgdGltZXN0YW1wID0gZGF0ZXRpbWUudXRjbm93KCkuaXNvZm9ybWF0KClcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdGFibGUucHV0X2l0ZW0oXG4gICAgICAgICAgICAgICAgSXRlbT17XG4gICAgICAgICAgICAgICAgICAgICdpbWFnZV9pZCc6IGVycm9yX2lkLFxuICAgICAgICAgICAgICAgICAgICAncHJvY2Vzc2luZ190aW1lc3RhbXAnOiB0aW1lc3RhbXAsXG4gICAgICAgICAgICAgICAgICAgICdzb3VyY2VfYnVja2V0JzogYnVja2V0IGlmICdidWNrZXQnIGluIGxvY2FscygpIGVsc2UgJ3Vua25vd24nLFxuICAgICAgICAgICAgICAgICAgICAnc291cmNlX2tleSc6IGtleSBpZiAna2V5JyBpbiBsb2NhbHMoKSBlbHNlICd1bmtub3duJyxcbiAgICAgICAgICAgICAgICAgICAgJ3Byb2Nlc3Npbmdfc3RhdHVzJzogJ2ZhaWxlZCcsXG4gICAgICAgICAgICAgICAgICAgICdlcnJvcl9tZXNzYWdlJzogc3RyKGUpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKVxuICAgICAgICBleGNlcHQ6XG4gICAgICAgICAgICBwYXNzXG4gICAgICAgICAgICBcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICdzdGF0dXNDb2RlJzogNTAwLFxuICAgICAgICAgICAgJ2JvZHknOiBqc29uLmR1bXBzKGYnRXJyb3I6IHtzdHIoZSl9JylcbiAgICAgICAgfVxuYCksXG4gICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgJ1RBQkxFX05BTUUnOiBzcGVjaWZpY2F0aW9uc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgJ0JVQ0tFVF9OQU1FJzogaW1hZ2VCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgUzMgZXZlbnQgbm90aWZpY2F0aW9uIHRvIHRyaWdnZXIgTGFtYmRhXG4gICAgaW1hZ2VCdWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURURfUFVULFxuICAgICAgbmV3IHMzbi5MYW1iZGFEZXN0aW5hdGlvbihvY3JQcm9jZXNzb3JGdW5jdGlvbiksXG4gICAgICB7IHN1ZmZpeDogJy5qcGcnIH1cbiAgICApO1xuXG4gICAgaW1hZ2VCdWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURURfUFVULFxuICAgICAgbmV3IHMzbi5MYW1iZGFEZXN0aW5hdGlvbihvY3JQcm9jZXNzb3JGdW5jdGlvbiksXG4gICAgICB7IHN1ZmZpeDogJy5qcGVnJyB9XG4gICAgKTtcblxuICAgIGltYWdlQnVja2V0LmFkZEV2ZW50Tm90aWZpY2F0aW9uKFxuICAgICAgczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVEX1BVVCxcbiAgICAgIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24ob2NyUHJvY2Vzc29yRnVuY3Rpb24pLFxuICAgICAgeyBzdWZmaXg6ICcucG5nJyB9XG4gICAgKTtcblxuICAgIC8vIE91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSW1hZ2VCdWNrZXROYW1lJywge1xuICAgICAgdmFsdWU6IGltYWdlQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ05hbWUgb2YgdGhlIFMzIGJ1Y2tldCBmb3IgcHJvZHVjdCBpbWFnZXMnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NwZWNpZmljYXRpb25zVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHNwZWNpZmljYXRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBEeW5hbW9EQiB0YWJsZSBmb3IgcHJvZHVjdCBzcGVjaWZpY2F0aW9ucycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTGFtYmRhRnVuY3Rpb25OYW1lJywge1xuICAgICAgdmFsdWU6IG9jclByb2Nlc3NvckZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgT0NSIHByb2Nlc3NvciBMYW1iZGEgZnVuY3Rpb24nLFxuICAgIH0pO1xuICB9XG59XG4iXX0=