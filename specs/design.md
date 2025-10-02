# Design Document

## Architecture Overview

The Product OCR Processor system implements a serverless event-driven architecture on AWS that automatically processes product images to extract specifications using AI-powered OCR.

## System Components

### Core Services
- **Amazon S3**: Primary storage for product images with event notifications
- **AWS Lambda**: Serverless compute for image processing logic
- **Amazon Bedrock**: AI service providing Claude model for image analysis and OCR
- **Amazon DynamoDB**: NoSQL database for flexible product specification storage
- **Amazon CloudWatch**: Logging and monitoring for system observability

### Data Flow Architecture

1. **Image Upload**: Product images are uploaded to designated S3 bucket
2. **Event Trigger**: S3 PUT events automatically trigger Lambda function
3. **AI Processing**: Lambda function invokes Bedrock Claude model for image analysis
4. **Data Extraction**: Claude model extracts structured product specifications
5. **Storage**: Extracted specifications are stored in DynamoDB with metadata

## Technical Architecture

### S3 Bucket Configuration
- Single bucket for product image storage
- Event notifications configured for PUT operations
- Versioning enabled for image history
- Server-side encryption enabled

### Lambda Function Design
- Runtime: Python 3.11
- Memory: 1024 MB (sufficient for image processing)
- Timeout: 5 minutes (adequate for Bedrock API calls)
- Environment variables for configuration
- Error handling with CloudWatch logging

### Bedrock Integration
- Model: `global.anthropic.claude-sonnet-4-20250514-v1:0`
- Input: Base64 encoded image data
- Output: Structured JSON with product specifications
- Retry logic for API failures

### DynamoDB Schema
```json
{
  "image_id": "string (partition key)",
  "processing_timestamp": "string (sort key)",
  "source_bucket": "string",
  "source_key": "string",
  "product_specifications": {
    "product_name": "string",
    "brand": "string",
    "category": "string",
    "specifications": "object (flexible)",
    "confidence_score": "number"
  },
  "processing_status": "string",
  "error_message": "string (optional)"
}
```

## Security Design

### IAM Roles and Policies
- **Lambda Execution Role**: Access to S3 (read), Bedrock (invoke), DynamoDB (write), CloudWatch (logs)
- **S3 Bucket Policy**: Restricted access with encryption requirements
- **Bedrock Access**: Specific model access with inference permissions

### Encryption
- S3: Server-side encryption with AWS managed keys
- DynamoDB: Encryption at rest enabled
- Lambda: Environment variables encrypted

## Sequence Diagram

```
User/System -> S3: Upload product image
S3 -> Lambda: Trigger event (S3 PUT)
Lambda -> S3: Read image data
Lambda -> Bedrock: Invoke Claude model with image
Bedrock -> Lambda: Return extracted specifications
Lambda -> DynamoDB: Store specifications
Lambda -> CloudWatch: Log processing results
```

## Error Handling Strategy

1. **S3 Upload Failures**: Automatic retry with exponential backoff
2. **Lambda Execution Errors**: Dead letter queue for failed invocations
3. **Bedrock API Failures**: Retry logic with circuit breaker pattern
4. **DynamoDB Write Failures**: Conditional writes with conflict resolution
5. **Image Processing Errors**: Graceful degradation with error logging

## Monitoring and Observability

- CloudWatch metrics for Lambda invocations, errors, and duration
- Custom metrics for Bedrock API calls and success rates
- DynamoDB metrics for read/write capacity and throttling
- Structured logging for debugging and audit trails

## Scalability Considerations

- Lambda concurrent execution limits
- DynamoDB auto-scaling for read/write capacity
- S3 request rate optimization
- Bedrock API rate limits and quotas
