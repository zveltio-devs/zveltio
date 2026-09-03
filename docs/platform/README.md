# Chapter 1 — Platform

What Zveltio is, how the pieces fit, and everything that is not specific to one
package: installing it, configuring it, isolating tenants, securing it, running
it, and working on it.

| Document | Read it when |
|---|---|
| [overview.md](overview.md) | You want the product in one page — what it is, who it is for, how it compares |
| [architecture.md](architecture.md) | You need the system shape: processes, data flow, request lifecycle |
| [installation.md](installation.md) | You are setting up a machine, for development or production |
| [configuration.md](configuration.md) | You need the environment-variable reference |
| [multi-tenancy.md](multi-tenancy.md) | You touch anything that reads or writes tenant data. **Mandatory before tenancy work** |
| [security.md](security.md) | You are hardening a deployment, or auditing the system |
| [operations.md](operations.md) | You run it: deploy, scale, monitor, degrade gracefully |
| [disaster-recovery.md](disaster-recovery.md) | Backups, restores, and the drills that prove them |
| [deployment-k8s.md](deployment-k8s.md) | You deploy on Kubernetes with the Helm chart |
| [development.md](development.md) | You are contributing code — workflow, tests, quality gates, conventions |
| [known-gaps.md](known-gaps.md) | You want the honest list of what is unfinished or knowingly rough |
| [audit-coverage.md](audit-coverage.md) | You need to know what the automated gates do and do not cover |
| [troubleshooting.md](troubleshooting.md) | Something is broken and you want the common causes first |

Reference material also in this chapter: [benchmarks](benchmarks.md),
[versioning](versioning.md), [horizontal scaling](horizontal-scaling.md),
[graceful degradation](degradation.md), [monitoring](monitoring.md),
[deployment](deployment.md), [Node.js fallback](nodejs-fallback.md),
[alpha → beta migration](migration-alpha-to-beta.md).
