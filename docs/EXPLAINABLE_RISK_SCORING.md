# Explainable Risk Scoring for High-Impact Actions (#461)

## Overview

High-impact actions (such as high-value ticket transfers, batch signers alterations, and rapid resale operations) are evaluated by a risk scoring engine that produces explainable breakdowns of policy dispositions (`allow`, `review`, `block`).

## Acceptance Criteria & Paths

### 1. Normal Path
- Standard actions with no risk signals evaluate to score 0 with disposition `allow`.
- Produces clear human-readable explanations summarizing the evaluation rationale.

### 2. Failure Path
- Misconfigured or invalid risk context (e.g. negative thresholds) yields disposition `block` with code `invalid_risk_context`.
- Explanations for invalid context do not leak internal threshold numbers.

### 3. Retry Path
- Repeated attempts within a short window trigger the `repeated_attempts` signal.
- The signal explanation clearly outlines the retry window observation and adds weight accordingly.

### 4. Authorization & Role-Based Disclosure Path
- **Privileged Reviewers** (`maintainer`, `organizer`, `reviewer`): Receive full `ExplainableRiskAssessment` containing individual signal weights, rule descriptions, and configured policy thresholds (`reviewScore`, `blockScore`).
- **Unprivileged Actors** (`attendee`, `anonymous`): Receive `SanitizedExplainableRiskAssessment` (`isSanitized: true`) containing a high-level summary without revealing sensitive scoring weights or threshold boundaries that could be gamed.

## Edge Cases and Rollback Behavior

- **High-Velocity Transfers**: Rapid resale triggers manual review rather than permanent blocking to allow operator discretion.
- **Audit Logging**: All assessments and disposition overrides are persisted in the transfer risk audit trail.
