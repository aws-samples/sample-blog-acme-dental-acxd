# Acme Dental — Agentic CX on Amazon Connect Customer

Sample code that deploys an agentic CX designer solution in Amazon Connect Customer for
multi-need member calls resolved in one conversation. It sets up a member self-service dental
experience built with Amazon Connect Customer and agentic CX designer (ACXD), backed by a
serverless API.

Follow the steps below in order.

> **Proof of concept.** This sample is intentionally simplified for a
> walkthrough and is not production-ready. See [security policy](https://github.com/aws-samples/sample-blog-acme-dental-acxd/security/policy) and the
> security notes below before using it with real data.

## Repository contents

| Path | What it is |
|------|------------|
| `acme-dental.yaml` | AWS CloudFormation template: Amazon API Gateway, AWS Lambda, and Amazon DynamoDB back end, plus the AWS Identity and Access Management (IAM) roles it needs. |
| `acxd-deploy/` | Node.js scripts that create the ACXD workspace and deploy its resources (flows, data requests, context variables, custom slot type, knowledge base, and application) through the ACXD software development kit (SDK). |
| `AcmeDental_Agent_Whisper.json` | Amazon Connect Customer agent whisper flow. |
| `AcmeDental_Inbound.json` | Amazon Connect Customer inbound flow. |

## Prerequisites

Validated in `us-east-1`. Choose an AWS Region that supports all the services used here. Deploy the CloudFormation stack and the ACXD resources in the same AWS Region. The ACXD deploy scripts use the default Region in your AWS configuration.

**AWS account access to:**
- An existing **Amazon Connect Customer instance** with:
  - Administrator access to **ACXD**
  - A claimed phone number
  - A configured agent on the **Basic routing profile**, with the voice channel enabled
- The **ACXD Admin Hub**, with a **programmatic user** and an **ACXD API key**
  (Admin Hub → Programmatic Users). The key is shown only once, when you create it.
  - Because you create and delete the workspace with the scripts below, the programmatic
    user needs an **account-level administrator** role. A key scoped to a single
    workspace can't create or delete workspaces.
- Permission to create Amazon API Gateway APIs, AWS Lambda functions, Amazon DynamoDB
  tables, IAM roles, AWS Key Management Service (AWS KMS) keys, and Amazon CloudWatch log
  groups through AWS CloudFormation.

**Local tools:**
- **Git**, to clone this repository
- **AWS Command Line Interface (AWS CLI) version 2**, configured with credentials and a
  default Region for this account, to retrieve the API key value
- **Node.js 20 or later** and **npm**, to run the ACXD deploy scripts

The terminal commands below are written for macOS. Use the equivalent commands for your
operating system.

## Step 1 — Clone the repository

```bash
git clone https://github.com/aws-samples/sample-blog-acme-dental-acxd.git
cd sample-blog-acme-dental-acxd
```

## Step 2 — Deploy the API Gateway, Lambda, DynamoDB, and IAM roles

The whole back end is one file, `acme-dental.yaml`. All Lambda code is inlined, so this
step needs no code upload and no `npm install`.

1. In the AWS CloudFormation console, choose **Create stack**, then **With new resources
   (standard)**. Choose **Upload a template file**, select `acme-dental.yaml` from the
   cloned repository, and choose **Next**.
2. Enter a descriptive **Stack name**. Resource names are prefixed with it, so this
   guide shows them as `<your-stack-name>-...`.
3. Choose **Next**.
4. Keep the default entries, select **I acknowledge that AWS CloudFormation might create
   IAM resources**, then choose **Next**.
5. Choose **Submit**.
6. When the status is **CREATE_COMPLETE**, open the **Outputs** tab and note **ApiUrl**
   and **ApiKeyId**. You need them in Step 4.

**Getting the API key value.** The key value itself isn't a stack output, because anyone
who can view the stack can read its outputs. Retrieve it by running the following command,
replacing `<ApiKeyId>` with the value from the previous step:

```bash
aws apigateway get-api-key --api-key <ApiKeyId> --include-value \
  --query value --output text
```

### What gets created

- **AWS Key Management Service (AWS KMS)**: a customer-managed key
  (`alias/<your-stack-name>-data`) with rotation enabled.
- **DynamoDB**: `<your-stack-name>-members`, `<your-stack-name>-plans`, and
  `<your-stack-name>-providers` — encrypted with the AWS KMS key, point-in-time recovery enabled, and seeded with
  fictional demo data.
- **Lambda**: `<your-stack-name>-handler` (plus a seed custom resource), `nodejs24.x`, with
  CloudWatch log groups that keep logs for 14 days.
- **API Gateway**: REST API `<your-stack-name>-api` with 6 routes, an API key and usage plan,
  access logging, and AWS X-Ray tracing.

## Step 3 — Add your user data to DynamoDB

So the solution recognizes your call, edit the seeded test member to use your phone number.

1. In the DynamoDB console, choose **Tables**.
2. Select the members table (`<your-stack-name>-members`) and choose **Explore table items**.
3. Choose the item `MID-1234` to open the **Edit item** page. Choose **JSON view**, turn off
   **View DynamoDB JSON**, replace the contents with the following JSON, and choose
   **Save and close**. Only the phone number must be real, so the solution can match your
   caller ID. Use the fictitious name and date of birth shown, or any test values.

```json
{
  "memberId": "MID-1234",
  "ani": "<your phone number in E.164 format, for example +11234567890>",
  "deductibleMet": true,
  "dob": "1990-01-01",
  "enrolledSince": "2020-01-01",
  "name": "Jane Doe",
  "planId": "PPO-ACME",
  "ytdUsed": 450,
  "zip": "07302"
}
```

E.164 is the international phone number format: a + followed by the country code and
number.

The plans and providers tables are pre-populated with fictitious values, so no updates to
those tables are required.

## Step 4 — Deploy the ACXD resources

### Knowledge base document

The `acmeDentalPolicies` knowledge base grounds the agent's answers about procedure
coverage. Its source document, a sample dental benefit schedule
(`Acme_Dental___Sample_Benefit_Schedule.pdf`), is included in:

```
acxd-deploy/knowledge-bases/acmeDentalPolicies/documents/
```

`deploy-all.mjs` uploads it and publishes the knowledge base. To use your own benefit
schedule, replace the PDF in that folder before deploying.

### Deploy

1. Go to the `acxd-deploy` directory:
   ```bash
   cd acxd-deploy
   ```
2. Download dependencies:
   ```bash
   npm install
   ```
3. Set your ACXD API key:
   ```bash
   export ACXD_API_KEY='<your_acxd_api_key>'
   ```
4. Create the "Acme Insurance WS" ACXD workspace and note the workspace ID it outputs:
   ```bash
   node deploy-workspace.mjs --name "Acme Insurance WS"
   ```
   The script prints the exact `export` line to use in the next step. If a workspace with
   that name already exists, the script reuses it.
5. Set your workspace ID:
   ```bash
   export ACXD_WORKSPACE_ID='<your_acxd_workspace_id>'
   ```
6. Deploy the ACXD resources:
   ```bash
   node deploy-all.mjs --deploy
   ```
   When prompted, enter the secret values for **`API_URL_Base`** (the **ApiUrl** from
   Step 2) and **`API_Key`** (the API key value from Step 2). Input is hidden, and the
   values are never written to disk. The script only asks for secrets that don't already
   exist, so a rerun won't ask again.

To preview what the script will do without creating anything, add `--dry-run`:

```bash
node deploy-all.mjs --dry-run --deploy
```

`deploy-all.mjs` deploys everything in dependency order (secrets, slot type, context
variables, knowledge base, data requests, flows, application), then builds the
application and deploys it to the `development` environment. The `acme-dental`
application includes:

- **8 flows:** `AcmeStart`, `AcmeMemberAuth`, `AcmeMemberMain`, `AcmeMemberJourney`,
  `AcmePlanDetails`, `AcmeLiveAgent`, `AcmeGoodbye`, `AcmeError`
- **4 data requests:** `acmeLookupAni`, `acmeVerifyMember`, `acmeGetPlanDetails`,
  `acmeFindProviders`
- **9 context variables**, **1 custom slot type** (`acmeMemberId`), and
  **1 knowledge base** (`acmeDentalPolicies`)

<details>
<summary>More <code>deploy-all.mjs</code> options</summary>

- `--build` — build the application without deploying it
- `--environment <env>` — deploy to `development` (default), `qa`, `staging`, or `production`
- `--no-secrets` — skip the secrets step
- `--no-publish-kb` — don't publish the knowledge base (it's published by default)

If a run ends before the deployment finishes, check its status without redeploying:

```bash
node check-deployment.mjs --app-id <applicationId> --deployment-id <id> --wait
```

The `applicationId` is printed on the `=== 7. Application ===` line of the deploy output.
</details>

## Step 5 — Import the agent whisper flow

1. Sign in to your Amazon Connect Customer instance.
2. Go to the **Routing** tab and choose **Flows**.
3. From the **Create flow** menu, choose **Create agent whisper flow**.
4. Open the menu next to **Save** and choose **Import (beta)**.
5. Choose **Choose file**, select `AcmeDental_Agent_Whisper.json`, and choose **Import**.
6. Choose **Save**, then **Publish**.

## Step 6 — Import the inbound flow and attach your phone number

1. In **Routing → Flows**, choose **Create flow**.
2. Open the menu next to **Save** and choose **Import (beta)**.
3. Choose **Choose file**, select `AcmeDental_Inbound.json`, and choose **Import**.
4. Open the **Agentic CX** flow block, select the ACXD application you deployed in Step 4,
   and choose **Confirm**.
5. Choose **Save**, then **Publish**.
6. Attach your claimed phone number to the inbound flow.

## Step 7 — Test the solution

Follow the steps below.

1. In the Amazon Connect Customer Contact Control Panel (CCP), set your agent status to
   **Available**.
2. Call your claimed phone number. Aria greets you and identifies you by your caller
   phone number (Automatic Number Identification, ANI).
3. **Deterministic experience:** confirm your date of birth (`1990-01-01` if you used the
   sample), then ask "What plan am I on?"
4. **Agentic experience:** ask "I need to get a crown on my molar. Is it covered? What
   will it cost me? And can you find me a dentist nearby that can perform this
   procedure?"
5. **Live agent escalation:** say "I'd like to speak to a representative" and confirm the
   call reaches your agent with the conversation context in the whisper.

Then review your test calls in Amazon Connect Customer contact search and ACXD Analytics.

## Cleaning up
The deployed resources, including the claimed phone number, incur charges until you delete them.


1. **CloudFormation stack.** In the CloudFormation console, select the stack and choose
   **Delete**. This deletes the deployed services and IAM roles. The template
   defines its CloudWatch log groups, so they're deleted with the stack; delete any
   remaining log groups from this deployment manually.
   - The customer-managed AWS KMS key is **kept** after the stack is deleted
     (`DeletionPolicy: Retain`). Schedule its deletion in the AWS KMS console if you no
     longer need it.
2. **ACXD workspace.** Delete the workspace and all its resources:
   ```bash
   cd acxd-deploy
   node destroy-workspace.mjs --name "Acme Insurance WS" --confirm
   ```
   Run it without `--confirm` to list what would be deleted without deleting it.
   To keep the workspace and remove only this project's resources, run
   `node destroy-all.mjs --confirm` instead (add `--keep-secrets` to keep the secrets).
3. **Amazon Connect Customer flows.** Archive and delete the inbound and agent whisper
   flows you imported.
4. **Phone number.** If you claimed a new phone number for this walkthrough, release it.
5. **ACXD credentials.** In the ACXD Admin Hub, delete the ACXD API key and the
   programmatic user you created for this walkthrough, if you no longer need them. Do this
   last, because the ACXD cleanup scripts above need the key.

## Security notes (proof of concept)

This sample is intentionally simple. Before using real data, harden it:

- The API key is for **metering, not authentication** — all methods are
  `AuthorizationType: NONE` + `ApiKeyRequired: true`. Add a real authorizer and AWS WAF
  for production.
- For production, store the API key and other credentials in AWS Secrets Manager or AWS
  Systems Manager Parameter Store and retrieve them at runtime.
- Never commit your ACXD API key. The scripts read it only from `ACXD_API_KEY`.
- DynamoDB deletion protection is **off** for demo convenience. Turn it on before storing
  real personally identifiable information.
- Date-of-birth verification is protected only by the API key and usage-plan throttling,
  with no per-member lockout. Add rate limiting before real use.
- The handler logs only the method and route (never request bodies, which carry personal
  data) and returns generic 500 errors. Keep it that way if you extend it.

## Development

```bash
cd acxd-deploy
npm install
npm run lint     # ESLint
npm test         # node:test unit tests
cfn-lint ../acme-dental.yaml
```

## License

This project is licensed under the terms in [LICENSE](LICENSE).
