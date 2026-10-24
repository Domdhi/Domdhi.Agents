<!-- @@template -->
# Architecture: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Date** | {YYYY-MM-DD} |
| **Source** | Based on PRD v{X} |

---

## System Overview

{2-3 paragraphs describing the system at a high level. What it does, who uses it, how it fits into the broader ecosystem.}

### Architecture Style
{Monolith / Microservices / Modular Monolith / Serverless / Hybrid}

### Key Quality Attributes
| Attribute | Priority | Target |
|-----------|----------|--------|
| Performance | {H/M/L} | {specific metric} |
| Scalability | {H/M/L} | {specific metric} |
| Security | {H/M/L} | {standard} |
| Availability | {H/M/L} | {SLA %} |
| Maintainability | {H/M/L} | {metric} |

---

## Tech Stack

### Backend
| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Framework | {name} | {ver} | {why chosen} |
| Language | {name} | {ver} | {why chosen} |
| ORM/Data | {name} | {ver} | {why chosen} |
| Real-time | {name} | {ver} | {why chosen} |
| Background Jobs | {name} | {ver} | {why chosen} |
| Logging | {name} | {ver} | {why chosen} |

### Frontend
| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Framework | {name} | {ver} | {why chosen} |
| Language | {name} | {ver} | {why chosen} |
| UI Library | {name} | {ver} | {why chosen} |
| Styling | {name} | {ver} | {why chosen} |
| State | {name} | {ver} | {why chosen} |

### Database
| Role | Technology | Version | Rationale |
|------|-----------|---------|-----------|
| Primary | {name} | {ver} | {why chosen} |
| Cache | {name} | {ver} | {why chosen} |
| Search | {name} | {ver} | {why chosen} |

### Infrastructure
| Service | Technology | Rationale |
|---------|-----------|-----------|
| Hosting | {name} | {why chosen} |
| CI/CD | {name} | {why chosen} |
| Monitoring | {name} | {why chosen} |

---

## Architecture Diagram

```
{ASCII diagram showing major components and their relationships}
```

---

## Component Architecture

### {Component Name}
- **Responsibility**: {what it does}
- **Technology**: {framework/library}
- **Dependencies**: {what it depends on}
- **API Surface**: {how other components interact with it}

### {Component Name}
- **Responsibility**: {what it does}
- **Technology**: {framework/library}
- **Dependencies**: {what it depends on}
- **API Surface**: {how other components interact with it}

---

## Data Architecture

### Entity-Relationship Overview
```
{ASCII ER diagram or description}
```

### Key Entities
| Entity | Storage | Access Pattern | Volume |
|--------|---------|---------------|--------|
| {name} | {table/collection} | {read-heavy/write-heavy/balanced} | {estimated rows} |

### Data Flow
```
{ASCII data flow diagram}
```

---

## API Design

### API Style
{REST / GraphQL / gRPC / Hybrid}

### Endpoint Groups
| Group | Base Path | Auth Required | Description |
|-------|-----------|---------------|-------------|
| {name} | /api/{group} | {Yes/No} | {purpose} |

### API Conventions
- Versioning: {strategy}
- Pagination: {approach}
- Error format: {structure}
- Rate limiting: {policy}

---

## Authentication & Authorization

### Authentication
- **Provider**: {method — AD, Azure AD, OAuth, JWT, etc.}
- **Flow**: {authorization code, client credentials, etc.}
- **Token**: {JWT, cookie, session, etc.}
- **Lifetime**: {duration, refresh strategy}

### Authorization
- **Model**: {RBAC / ABAC / Claims-based}
- **Roles**: {list of roles}
- **Policies**: {key policies}

---

## Infrastructure & Deployment

### Deployment Architecture
```
{ASCII deployment diagram — servers, load balancers, databases}
```

### Environments
| Environment | Purpose | URL | Notes |
|------------|---------|-----|-------|
| Development | Local dev | localhost | {notes} |
| Staging | Pre-prod testing | {url} | {notes} |
| Production | Live | {url} | {notes} |

### CI/CD Pipeline
```
{Build → Test → Stage → Deploy flow}
```

---

## Architecture Decision Records (ADRs)

### ADR-001: {Decision Title}
- **Status**: Accepted
- **Date**: {YYYY-MM-DD}
- **Context**: {Why this decision was needed}
- **Decision**: {What was decided}
- **Alternatives Considered**:
  - {Option A}: {pros/cons}
  - {Option B}: {pros/cons}
- **Consequences**: {What this means going forward}

---

## Cross-Cutting Concerns

### Logging
- **Framework**: {name}
- **Levels**: {Debug, Info, Warning, Error, Critical}
- **Structured**: {Yes/No}
- **Destination**: {file, database, service}

### Error Handling
- **Strategy**: {global handler, middleware, result pattern}
- **User-facing**: {how errors are presented}
- **Internal**: {how errors are logged and alerted}

### Caching
- **L1**: {in-memory — strategy, TTL}
- **L2**: {distributed — strategy, TTL}
- **Invalidation**: {approach}

### Configuration
- **Source**: {appsettings, environment vars, config service}
- **Secrets**: {vault, user-secrets, env vars}
- **Feature Flags**: {service or config-based}

---

## Development Standards

### Project Structure
```
{Directory tree showing the canonical project layout}
```

### Coding Conventions
- {Key conventions specific to this project}

### Testing Strategy
| Level | Framework | Coverage Target | What's Tested |
|-------|-----------|-----------------|---------------|
| Unit | {name} | {%} | {scope} |
| Integration | {name} | {%} | {scope} |
| E2E | {name} | {%} | {scope} |

---

## Related Documents
- PRD: [product/requirements.md](../product/requirements.md)
- UX Spec: [design/spec.md](../design/spec.md)
- Epics: [work/backlog.md](../work/backlog.md)
