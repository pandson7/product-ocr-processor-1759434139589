import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

export class ProductOcrProcessorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
import re
from datetime import datetime
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')
bedrock_client = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')

def extract_json_from_text(text):
    """Extract JSON from text that might be wrapped in markdown code blocks"""
    text = text.strip()
    if text.startswith('\\`\\`\\`json'):
        text = text[7:]
    if text.startswith('\\`\\`\\`'):
        text = text[3:]
    if text.endswith('\\`\\`\\`'):
        text = text[:-3]
    
    json_match = re.search(r'\\{.*\\}', text, re.DOTALL)
    if json_match:
        return json_match.group(0)
    
    return text.strip()

def handler(event, context):
    try:
        for record in event['Records']:
            bucket = record['s3']['bucket']['name']
            key = record['s3']['object']['key']
            
            logger.info(f"Processing image: {bucket}/{key}")
            
            response = s3_client.get_object(Bucket=bucket, Key=key)
            image_data = response['Body'].read()
            image_base64 = base64.b64encode(image_data).decode('utf-8')
            
            prompt = """
            Analyze this product image and extract the following information in JSON format:
            - product_name: The name of the product
            - brand: The brand or manufacturer
            - category: Product category
            - specifications: Any technical specifications, features, or details visible
            - confidence_score: Your confidence in the extraction (0-1)
            
            Return only valid JSON without any additional text or markdown formatting.
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
            
            bedrock_response = bedrock_client.invoke_model(
                modelId='global.anthropic.claude-sonnet-4-20250514-v1:0',
                body=json.dumps(bedrock_request)
            )
            
            response_body = json.loads(bedrock_response['body'].read())
            extracted_text = response_body['content'][0]['text']
            
            try:
                clean_json = extract_json_from_text(extracted_text)
                specifications = json.loads(clean_json)
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse JSON: {e}")
                specifications = {"error": "Failed to parse JSON", "raw_text": extracted_text}
            
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
    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(ocrProcessorFunction),
      { suffix: '.jpg' }
    );

    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(ocrProcessorFunction),
      { suffix: '.jpeg' }
    );

    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(ocrProcessorFunction),
      { suffix: '.png' }
    );

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
