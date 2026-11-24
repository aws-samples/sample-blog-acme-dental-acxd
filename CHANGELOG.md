# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Customer-managed KMS key with key rotation encrypting all DynamoDB tables.
- Point-in-time recovery on all DynamoDB tables.
- API Gateway access logging and X-Ray tracing.
- Explicit CloudWatch log groups with 14-day retention for Lambda and API Gateway.
- ESLint flat config and `npm run lint` script.
- `node:test` unit tests for the flow and secret transform logic.
- Standard open-source repository files (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, SUPPORT, CHANGELOG, issue/PR templates, CI workflow).

### Changed
- Lambda runtime upgraded from `nodejs20.x` to `nodejs24.x`.
- `secret.mjs` now reads raw keypresses instead of filtering stdout, closing a
  secret-echo leak on backspace/arrow keys.
- IAM roles tightened to least privilege (scoped API key read, split GetItem/Query,
  removed unused DynamoDB actions).
- API key value is no longer a CloudFormation output; retrieve it via the AWS CLI.
- Hardcoded `arn:aws` partitions replaced with `${AWS::Partition}`.
- README rewritten to match actual repository contents.

### Fixed
- `JSON.parse` of the request body moved inside try/catch; malformed bodies now
  return a structured 400 instead of a raw 502.
- `/preauth` no longer reflects the full request body (PII risk); returns only
  known fields.
- `/verify/member` validates input and returns 400 instead of 500 on missing keys.
- Removed API Gateway methods (`/verify/provider`, `/cost/estimate`) that had no
  handler code and always returned 404.
- Seed custom resource now logs and fails fast on a CloudFormation callback error
  instead of silently hanging the stack.
