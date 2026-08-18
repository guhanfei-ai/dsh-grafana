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
- Every `grafana_push` call enters DSH's native approval flow and fails closed when approval is unavailable.
- Dashboard identity, version, and folder are checked immediately before a write.
- Configured Grafana hosts are trusted destinations. Operators remain responsible for DNS, TLS, network routing, and model-provider data policy.

