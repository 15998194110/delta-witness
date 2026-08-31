# One-time authorization checklist

These are ownership/authentication gates, not recurring human operations. Do not put secrets in chat or source control.

- GitHub repository under the intended long-term owner. This becomes the release-control plane.
- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` stored as GitHub Actions secrets.
- Generate `DELTA_PARTNER_SECRET` (32+ random bytes) and store it in GitHub Actions + each marketplace's secret manager.
- npm: create account and configure Trusted Publisher for `.github/workflows/release-train.yml`.
- PyPI: create/claim project and configure Trusted Publishing for the same repository/workflow.
- Postman: API key. The sync script can create a workspace/collection, but making it public may require account permission/approval.
- Apify: API token + developer KYC + one-time PPE/store monetization configuration.
- RapidAPI: provider account + billing/payout onboarding + one-time API listing/pricing + Proxy Secret configured to equal `DELTA_PARTNER_SECRET`.
- Chrome: only after human checkout exists. Developer registration, 2SV, initial listing/privacy metadata and API authorization are one-time gates; store review remains controlled by Google.
