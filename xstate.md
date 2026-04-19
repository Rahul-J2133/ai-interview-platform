Good — this is the right way to “de-mystify” XState. Instead of magic, you want a **map of all moving parts**.

I’ll give you a **structured, slightly advanced cheat sheet** of the most important config fields in XState v5, grouped by where they belong and *why you’d use them*.

---

# 🧠 1. Top-level machine config

```ts
createMachine({
  id,
  initial,
  context,
  states,
  on,
  output,
  types
})
```

---

## 🔹 `id`

```ts
id: "interviewSession"
```

* Unique identifier for the machine
* Useful for debugging, devtools, actor hierarchy

---

## 🔹 `initial`

```ts
initial: "idle"
```

* Starting state when `actor.start()` is called

---

## 🔹 `context`

```ts
context: ({ input }) => ({
  sessionId: input.sessionId,
  score: 0
})
```

* Local state (mutable via `assign`)
* Can be derived from `input` in v5

👉 Use for:

* session data
* intermediate results
* references to child actors

---

## 🔹 `states`

```ts
states: { ... }
```

* Core of the machine (state definitions)

---

## 🔹 `on` (global transitions)

```ts
on: {
  CANCEL: { target: "cancelled" }
}
```

* Events handled from **any state**

👉 Use for:

* global escape (cancel, reset, error)

---

## 🔹 `output` (v5 feature)

```ts
output: ({ context }) => context.result
```

* Final result when machine completes

👉 Useful for:

* workflows
* returning data from child actors

---

## 🔹 `types` (TypeScript)

```ts
types: {} as {
  context: Context;
  events: Events;
}
```

* Strong typing for:

  * context
  * events
  * input/output

---

# 🧩 2. State node config

Inside `states: {}`:

```ts
someState: {
  entry,
  exit,
  on,
  after,
  always,
  invoke,
  initial,
  states,
  type,
  tags
}
```

---

## 🔹 `entry`

```ts
entry: (ctx) => console.log("entered")
```

* Runs when state is entered

👉 Use for:

* logging
* triggering side effects
* initializing things

---

## 🔹 `exit`

```ts
exit: () => cleanup()
```

* Runs when leaving state

👉 Use for:

* cleanup
* stopping timers manually

---

## 🔹 `on` (state-level transitions)

```ts
on: {
  NEXT: { target: "nextState" }
}
```

* Event → transition mapping

---

## 🔹 `after` (delayed transitions)

```ts
after: {
  1000: { target: "timeout" }
}
```

* Automatic transition after delay

👉 Internally creates timer-based events

---

## 🔹 `always` (eventless transitions)

```ts
always: {
  target: "next",
  guard: (ctx) => ctx.ready
}
```

* Runs immediately after entering state

👉 Use for:

* conditional routing
* branching logic

---

## 🔹 `invoke` (🔥 very important)

```ts
invoke: {
  src: fetchData,
  id: "fetch",
  onDone: { target: "success" },
  onError: { target: "failure" }
}
```

* Starts a **child actor (service)**

👉 Use for:

* API calls
* async workflows
* background jobs

---

## 🔹 `initial` (nested states)

```ts
initial: "step1"
```

* For compound states

---

## 🔹 `states` (nested machine)

```ts
states: {
  step1: {},
  step2: {}
}
```

* Enables hierarchy

---

## 🔹 `type`

```ts
type: "final"
```

Types:

* `"atomic"` (default)
* `"compound"`
* `"parallel"`
* `"final"`

👉 Use:

* `final` → marks completion
* `parallel` → run states simultaneously

---

## 🔹 `tags`

```ts
tags: ["loading"]
```

* Metadata for states

👉 Use for:

* UI logic
* grouping states

---

# 🔁 3. Transition config

Inside `on`, `after`, `always`:

```ts
{
  target,
  guard,
  actions,
  reenter
}
```

---

## 🔹 `target`

```ts
target: "nextState"
```

* Where to go

---

## 🔹 `guard`

```ts
guard: (ctx, event) => ctx.valid
```

* Condition to allow transition

---

## 🔹 `actions`

```ts
actions: assign({ count: ctx => ctx.count + 1 })
```

* Side effects during transition

---

## 🔹 `reenter` (v5 nuance)

```ts
reenter: true
```

* Forces re-entry even if same state

👉 Useful for:

* restarting services
* retriggering entry logic

---

# ⚙️ 4. Actions (config-level)

Defined via `setup()` or inline:

```ts
actions: {
  log: (ctx) => console.log(ctx)
}
```

Used as:

```ts
actions: "log"
```

---

## Common built-in actions

### 🔹 `assign`

```ts
assign({ value: 1 })
```

### 🔹 `sendTo`

```ts
sendTo(childRef, { type: "PING" })
```

### 🔹 `raise`

```ts
raise({ type: "INTERNAL_EVENT" })
```

👉 Sends event internally (no async)

---

# 🌐 5. Services / Actors

Defined in `setup()`:

```ts
actors: {
  fetchData: fromPromise(async () => ...)
}
```

Used in:

```ts
invoke: {
  src: "fetchData"
}
```

---

## Types of actor logic

* `fromPromise` → async
* `fromTransition` → reducer-like
* `fromObservable`
* `fromCallback`

---

# 🔄 6. Advanced / Less obvious fields

---

## 🔹 `input` (passed at actor creation)

```ts
createActor(machine, {
  input: { sessionId: "123" }
})
```

Used in:

```ts
context: ({ input }) => ...
```

---

## 🔹 `meta`

```ts
meta: {
  description: "This state handles loading"
}
```

👉 For tooling / debugging

---

## 🔹 `description`

```ts
description: "Loading state"
```

---

## 🔹 `order` (rare)

Controls transition priority (advanced use)

---

# 🔥 7. Most important fields (80/20 rule)

If you focus on these, you’re solid:

### Core:

* `context`
* `states`
* `initial`
* `on`

### Flow control:

* `guard`
* `actions`
* `entry` / `exit`

### Async:

* `invoke`
* `onDone` / `onError`

### Automation:

* `after`
* `always`

---

# 🧭 Final mental structure

Think of a machine as:

```txt
STATE
  ├── on (events)
  ├── entry / exit
  ├── invoke (async actors)
  ├── after (timers)
  └── always (auto transitions)
```

---

# 🎯 One-line takeaway

> XState config = **“when this happens → check this → do this → go here”**

---
