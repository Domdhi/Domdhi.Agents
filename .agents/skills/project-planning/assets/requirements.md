<!-- @@template -->
# Product Requirements Document: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Project** | {Project Name} |
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Date** | {YYYY-MM-DD} |
| **Tech Stack** | {language + framework + database} |

---

## Executive Summary

{2-3 paragraphs: What this product does, who it's for, and the key value proposition. Should be readable by non-technical stakeholders.}

---

## User Personas

### Persona 1: {Name} ({Role})
- **Background**: {context about this user}
- **Goals**: {what they want to accomplish}
- **Frustrations**: {current pain points}
- **Tech Comfort**: {Low / Medium / High}

### Persona 2: {Name} ({Role})
- **Background**: {context}
- **Goals**: {what they want}
- **Frustrations**: {pain points}
- **Tech Comfort**: {level}

---

## Functional Requirements

### Module: {Module Name}

#### FR-1: {Requirement Title}
- **Priority**: Must Have
- **Persona**: {which persona(s)}
- **Description**: {what the system must do}
- **Acceptance Criteria**:
  - Given {precondition}, When {action}, Then {expected result}
  - Given {precondition}, When {action}, Then {expected result}
- **Notes**: {edge cases, clarifications}

#### FR-2: {Requirement Title}
- **Priority**: Should Have
- **Persona**: {which persona(s)}
- **Description**: {what the system must do}
- **Acceptance Criteria**:
  - Given {precondition}, When {action}, Then {expected result}

---

## Non-Functional Requirements

### Performance
| ID | Requirement | Target | Priority |
|----|------------|--------|----------|
| NFR-P1 | {requirement} | {metric} | Must Have |

### Security
| ID | Requirement | Standard | Priority |
|----|------------|----------|----------|
| NFR-S1 | {requirement} | {reference} | Must Have |

### Scalability
| ID | Requirement | Target | Priority |
|----|------------|--------|----------|
| NFR-SC1 | {requirement} | {metric} | Should Have |

### Reliability
| ID | Requirement | Target | Priority |
|----|------------|--------|----------|
| NFR-R1 | {requirement} | {metric} | Must Have |

### Accessibility
| ID | Requirement | Standard | Priority |
|----|------------|----------|----------|
| NFR-A1 | {requirement} | {WCAG level} | Should Have |

---

## User Flows

### Flow 1: {Flow Name}
1. User navigates to {page}
2. System displays {content}
3. User clicks {action}
4. System {response}
   - If {condition}: {alternate path}
   - If {error}: {error handling}
5. User sees {result}

### Flow 2: {Flow Name}
1. {step}
2. {step}

---

## Data Model (Conceptual)

{High-level entities and relationships — NOT the database schema, just the domain model}

### Entities
| Entity | Description | Key Attributes |
|--------|------------|----------------|
| {name} | {what it represents} | {important fields} |

### Relationships
- {Entity A} has many {Entity B}
- {Entity C} belongs to {Entity D}

---

## API Surface (if applicable)

| Group | Purpose | Key Operations |
|-------|---------|----------------|
| {group} | {what it handles} | CRUD, search, export |

---

## Security Requirements

- **Authentication**: {method — SSO, OAuth, local, etc.}
- **Authorization**: {model — RBAC, ABAC, etc.}
- **Data Protection**: {encryption, PII handling}
- **Audit**: {what gets logged}
- **Compliance**: {standards — HIPAA, SOC2, GDPR, etc.}

---

## Assumptions & Dependencies

### Assumptions
- {Things assumed to be true}

### Dependencies
- {External systems, APIs, or teams this depends on}

---

## Success Criteria

| Criteria | Target | Measurement |
|----------|--------|-------------|
| {what} | {target} | {how measured} |

---

## Glossary

| Term | Definition |
|------|-----------|
| {term} | {definition} |

---

## Related Documents
- Project Brief: [product/brief.md](brief.md)
- UX Spec: [design/spec.md](../design/spec.md)
- Architecture: [architecture/overview.md](../architecture/overview.md)
