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
    # Remove markdown code blocks if present
    text = text.strip()
    if text.startswith('```json'):
        text = text[7:]  # Remove ```json
    if text.startswith('```'):
        text = text[3:]   # Remove ```
    if text.endswith('```'):
        text = text[:-3]  # Remove trailing ```
    
    # Try to find JSON object in the text
    json_match = re.search(r'\{.*\}', text, re.DOTALL)
    if json_match:
        return json_match.group(0)
    
    return text.strip()

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
            
            # Call Bedrock
            bedrock_response = bedrock_client.invoke_model(
                modelId='global.anthropic.claude-sonnet-4-20250514-v1:0',
                body=json.dumps(bedrock_request)
            )
            
            response_body = json.loads(bedrock_response['body'].read())
            extracted_text = response_body['content'][0]['text']
            
            # Parse extracted specifications
            try:
                # Clean the text and extract JSON
                clean_json = extract_json_from_text(extracted_text)
                specifications = json.loads(clean_json)
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse JSON: {e}")
                specifications = {"error": "Failed to parse JSON", "raw_text": extracted_text}
            
            # Store in DynamoDB
            table = dynamodb.Table('product-specifications-1759434139589')
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
            table = dynamodb.Table('product-specifications-1759434139589')
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
