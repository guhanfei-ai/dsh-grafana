# Security policy

## Supported versions

Security fixes are provided for the latest released pre-1.0 version only. Users should install an immutable Git tag and upgrade promptly when a new release is published.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, credential leak, SSRF path, approval bypass, or unsafe dashboard overwrite.

Use GitHub's private vulnerability reporting or a private Security Advisory for `guhanfei-ai/dsh-grafana`. Include:

- affected version and DSH/Grafana versions;
- reproduction steps or a minimal proof of concept;
- expected impact;
- suggested remediation, if available.

If private reporting is unavailable, contact the repository owner privately before disclosing details. Please allow a reasonable remediation window before public disclosure.

## Security model

- Grafana credentials are resolved only on the DSH host.
- Browser configuration uses DSH's privileged loopback-same-origin credential RPC.
- Profiles may share a credential store while keeping separate source configurations. The settings client never automatically deletes credentials after rotation, removal or an unconfirmed save; without host-wide coordination, a local reference check cannot prove deletion is safe. Retained credentials may accumulate and remain valid at Grafana until revoked there; source removal is not credential revocation.
- Credential status is configured, missing or unknown. Provider failures and malformed status replies are unknown, never proof of absence or successful authentication.
- Both `grafana_push` and `grafana_clone` require native approval by default and fail closed when it is unavailable. This plugin explicitly maps the calling session's live `danger-full-access` file policy to skipping its own extra confirmation; it is not a host-wide grant for remote services. Upstream decisions, plugin read-only mode, target-source binding, and write validation remain in force.
- Disabled approval prompts alone never grant permission. A known `never` policy without a full-access exemption produces an automatic-policy-denial error, not a claim that the user clicked Reject. Missing or unreadable policy capabilities never introduce an exemption.
- Dashboard identity, version, and folder are checked immediately before a write.
- Configured Grafana hosts are trusted destinations. Operators remain responsible for DNS, TLS, network routing, and model-provider data policy.

