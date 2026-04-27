#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"
QUEUE_NAME="tickets"
DLQ_NAME="tickets-dlq"

AWS="aws --endpoint-url=$ENDPOINT --region=$REGION"

echo "Waiting for LocalStack..."
until $AWS sqs list-queues > /dev/null 2>&1; do
  sleep 1
done

echo "Creating DLQ: $DLQ_NAME"
DLQ_URL=$($AWS sqs create-queue --queue-name "$DLQ_NAME" --query 'QueueUrl' --output text)
DLQ_ARN=$($AWS sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "Creating queue: $QUEUE_NAME"
$AWS sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "{
    \"VisibilityTimeout\": \"300\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"
  }"

echo "Done. Queue URL: $ENDPOINT/000000000000/$QUEUE_NAME"
