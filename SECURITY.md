# Security

Please report a vulnerability privately through GitHub's "Report a vulnerability" button on the
repository's Security tab, not in a public issue. Include what you found and how to reproduce it.

Things worth knowing when you deploy the gateway:

- Set `GATEWAY_API_KEYS`. With it empty the API is open to anyone who can reach the port, and each
  call spends your provider credits.
- `/health`, `/ready`, `/metrics`, the documentation endpoints and the dashboard's static files
  are served without a key. Metrics include provider names, traffic volumes and balances, so do
  not expose `/metrics` to the public internet.
- Provider API keys are read from the environment and are never logged, stored or returned. The
  call log identifies a key by the first 8 hex digits of its SHA-256.
- The call log stores queries, results and, with `STORE_RAW=true`, full upstream responses. Use
  `CALL_LOG_RETENTION_DAYS` and `RAW_RETENTION_DAYS` if that data should not be kept indefinitely.
- The dashboard keeps the gateway API key in the browser's local storage.
