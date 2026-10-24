---
name: Shared renovation planning
description: Product purpose and long-term collaboration direction for the floor-plan editor.
---

This app is for two people planning their home renovation together. The long-term direction is for AI and people to edit the same floor-plan data.

**Why:** The user explicitly stated this product purpose and future direction.

**How to apply:** Keep the floor-plan model portable and independently addressable so future collaborators can operate on the same shared plan rather than separate copies.

User-confirmed integrity rules: room outlines use ordered, directed wall-ID references; conflicting V1 room/wall data is shown as both room-authoritative and wall-authoritative migration candidates; an edit is rejected without changing the prior plan if an attached door no longer fits.

**Why:** The user chose these rules so future AI and human edits preserve shared geometry and existing data.

**How to apply:** Preserve these behaviors when changing the schema, migration flow, or wall and door editing.
