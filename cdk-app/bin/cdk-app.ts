#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProductOcrProcessorStack } from '../lib/cdk-app-stack';

const app = new cdk.App();
new ProductOcrProcessorStack(app, 'ProductOcrProcessorStack1759434139589', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});