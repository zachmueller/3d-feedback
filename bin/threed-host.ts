#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { ThreedHostStack } from '../lib/threed-host-stack';

const app = new cdk.App();

// Local secret/config overrides. `config.local.json` is gitignored, so real
// values (allowlisted emails, Google OAuth client id/secret) never get
// committed. Anything here takes precedence over the placeholders in cdk.json.
// Example contents:
//   {
//     "threedHost:allowedEmails": "me@example.com",
//     "threedHost:domainEnabled": "true",
//     "threedHost:googleClientId": "....apps.googleusercontent.com",
//     "threedHost:googleClientSecret": "...."
//   }
const localConfigPath = path.join(__dirname, '..', 'config.local.json');
if (fs.existsSync(localConfigPath)) {
  const overrides = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8')) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    app.node.setContext(key, value);
  }
}

new ThreedHostStack(app, 'ThreedHostStack', {
  // CloudFront, ACM certificates for CloudFront, and the Cognito Hosted UI all
  // live most simply in us-east-1; the design pins everything there.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Serverless host for sharing 3D models with per-revision feedback (3d.zach.nz)',
});
