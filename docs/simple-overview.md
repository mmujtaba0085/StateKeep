# StateKeep — Plain English Overview

This document explains what StateKeep is and what it does, without assuming any technical background.

---

## What is StateKeep?

StateKeep is a service that tracks the status of things that move through steps.

Think of it like a very sophisticated checklist that never forgets where anything is, never lets a step happen out of order, and keeps a permanent record of every change that ever occurred.

**Example:** An online order goes through steps — placed, paid, shipped, delivered. StateKeep tracks exactly where each order is in that journey, records every event that moved it forward, and ensures the logic is followed correctly every time.

---

## The Problem It Solves

Most applications need to track the lifecycle of something: an order, a loan application, a user onboarding flow, a subscription, a support ticket.

The traditional approach is to add a `status` column to a database table and write code that updates it. This sounds simple but becomes complicated quickly:

- What happens if two events arrive at the same time?
- How do you ensure transitions only happen in the right order?
- What if you need to change the workflow for orders already in progress?
- How do you audit what happened and when?

Teams end up with a tangle of status flags, migration scripts, and fragile conditional logic spread across multiple files. When the workflow needs to change, the risk of breaking things already in flight is high.

StateKeep handles all of this properly so you don't have to.

---

## How It Works

There are three steps:

**1. Describe your workflow**

You write a simple description of the steps (called "states") and what moves something from one step to the next (called "transitions"). For example: an order starts in `pending`, moves to `paid` when a payment event arrives, moves to `shipped` when a fulfillment event arrives, and is done when it reaches `delivered`.

**2. Start an instance for each entity**

When a new order is placed, your backend asks StateKeep to start a new instance (called an "actor") for that order. StateKeep assigns it an ID and tracks it from that moment on.

**3. Send events as things happen**

Whenever something happens in your system — payment confirmed, item shipped — your backend sends that event to StateKeep. StateKeep advances the instance to the next step, records the event in its history, and tells you the new status.

That's it. Your backend stays focused on the work (processing payments, triggering shipments). StateKeep stays focused on tracking where everything is.

---

## What Makes It Different

The thing that separates StateKeep from a simple status column is what happens when **your workflow needs to change**.

Imagine you have 10,000 orders in progress and you need to add a new "quality review" step between payment and shipping. With a traditional approach, you'd need to write a database migration, figure out which orders should get the new step, handle edge cases for orders already past that point, and test that nothing broke.

With StateKeep, you deploy a new version of your workflow definition. StateKeep automatically figures out which in-progress instances should move to the new version (based on where they are and what path they took to get there) and which ones should stay on the old version and complete normally.

No manual migration scripts. No stranded records. No risk of changing something for customers who should follow the old flow.

---

## What StateKeep Does NOT Do

StateKeep tracks state and history. It does not:

- Send emails or notifications — that's your backend's job
- Process payments or call external APIs
- Store your business data (customer details, product catalog, etc.)
- Make decisions about what should happen — that's your workflow definition

Your backend is in charge of the side effects. StateKeep is in charge of tracking where things are.

---

## Who It's For

StateKeep is useful for any team building workflows where things move through defined steps and mistakes are costly:

- **E-commerce** — order lifecycle from cart to delivered
- **Fintech** — loan applications, KYC verification, payout flows
- **SaaS onboarding** — trial → activated → churned, with upsell steps
- **Subscription billing** — active → past_due → cancelled → reactivated
- **Document approval** — draft → in_review → approved → published
- **Insurance claims** — submitted → under_review → approved → paid
- **Support tickets** — open → assigned → in_progress → resolved → closed

If your domain has a thing that moves through states and you care about the history of how it got there, StateKeep is the right tool.

---

## Key Numbers

- **Sub-10ms state transitions** — sending an event and getting the new state back takes under 10 milliseconds
- **Unlimited event history** — every event ever sent to every actor is stored permanently and queryable
- **Thousands of concurrent actors** — the system handles thousands of live workflow instances simultaneously
- **Zero-downtime definition upgrades** — deploying a new workflow version doesn't interrupt any in-flight actors

---

## The Short Version

StateKeep is what you use when your app needs to track "where is this thing in its lifecycle?" — reliably, permanently, and without reinventing state machine logic yourself.
