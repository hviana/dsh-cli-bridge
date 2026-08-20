<div align="center">

<!-- logo: the three pillars, bridged -->
<p><b>🟢&nbsp;&nbsp;━━&nbsp;&nbsp;🔵&nbsp;&nbsp;━━&nbsp;&nbsp;🟣</b></p>
<p><small>the three pillars, bridged</small></p>

<pre>
╭───────────────────────────────────────────────────────╮
│                                                       │
│               dsh ⇄ claude code · codex               │
│                                                       │
│    Run Claude Code & Codex inside DeepSeek Harness    │
│               — watch every step, live                │
│                                                       │
│            live · autonomous · zero setup             │
│                                                       │
╰───────────────────────────────────────────────────────╯
</pre>

# `dsh-cli-bridge`

Other tools hand you the final result. This one shows you the whole job, live.

[![npm](https://img.shields.io/npm/v/dsh-cli-bridge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-cli-bridge)
[![ci](https://github.com/hviana/dsh-cli-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hviana/dsh-cli-bridge/actions/workflows/ci.yml)
[![source-available](https://img.shields.io/badge/licence-source--available-8b5cf6)](./LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-5a67d8)](https://github.com/topics/dsh-plugin)
[![sponsor](https://img.shields.io/github/sponsors/hviana?label=sponsor&color=db61a2&logo=github)](https://github.com/sponsors/hviana)

</div>

---

## What it does

**One request in the chat. Claude Code or Codex doing real work — on screen, in
real time, under your control.**

`dsh-cli-bridge` hands work to **Claude Code** and **Codex**, then keeps you and
DeepSeek Harness in the loop for the whole job:

| **📺 Watch it live**                                                                                                      | **🧠 Give DSH the wheel**                                                                                                         | **🛠️ Nothing to set up**                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Every command, every file changed, every line of thought appears in DSH as it happens — not a spinner, not a final paste. | DeepSeek can steer, answer, and review the work on its own, step after step — or hand you the question when it should not decide. | It handles Claude Code and Codex for you. You install one plugin; it takes care of the rest. |

> [!IMPORTANT]
> **Why this exists** — the built-in Claude Code and Codex integration runs in
> the background and returns only the final message. You can't see what it is
> doing, and it bills you twice. `dsh-cli-bridge` shows the whole job on screen,
> keeps the details out of your conversation, and gives DeepSeek the controls.

---

## The difference

| The built-in way                       | ✨ `dsh-cli-bridge`                                       |
| -------------------------------------- | --------------------------------------------------------- |
| ❌ you get only the final result       | ✅ the whole job, live in DSH                             |
| ❌ DeepSeek just reads the answer      | ✅ DeepSeek steers, answers, and reviews the work         |
| ❌ you set them up yourself            | ✅ everything is set up for you                           |
| ❌ one login, set up by hand           | ✅ many separate accounts, side by side                   |
| ❌ tasks share one folder              | ✅ each task gets its own copy, merged back automatically |
| ❌ Claude Code talks to Anthropic only | ✅ Claude Code + Codex, plus any compatible provider      |

---

## And the rest

The headline is watching it live. The rest is what makes it safe to let Claude
Code or Codex loose on a project:

- **👥 Multi-account, isolated** — each account is kept separate; one login
  never touches another.
- **🌐 Any provider** — Claude Code can reach DeepSeek, OpenRouter, or any
  compatible provider.
- **🌿 Its own copy & automatic merge** — several tasks each get their own copy;
  finished work is merged back automatically, one at a time, and conflicts are
  kept for you.
- **🧭 It asks clearly** — when it needs a decision, it asks you plainly instead
  of guessing.
- **🔒 Respects your settings** — it follows your Read Only / Workspace Write /
  Full Access choice, and adds no rules of its own.
- **⚙️ Model & effort per task** — each task can name its own model and how hard
  to try, or use sensible defaults.

---

## Install

```sh
dsh plugin --profile web add dsh-cli-bridge
```

---

## Usage

### Getting started

1. **Install** the plugin once, in a terminal:

   ```sh
   dsh plugin --profile web add dsh-cli-bridge
   ```

2. **Open** DeepSeek Harness and start a conversation.

3. **Ask**, in the message box, what you want. For example:

   > "Use Claude Code to add a login page."

   DeepSeek takes it from there: it walks you through signing in (a box opens in
   the browser for the code) and runs the work with Claude Code or Codex while
   you watch.

### Signing in (accounts)

The first time you ask for something, DeepSeek helps you sign in to Claude Code
or Codex. A box opens in the browser — type the code and press Enter.

Each account stays separate, so you can keep more than one. Just ask:

- "Add my other Claude Code account."
- "Make that one the default."
- "Use my Claude Code API key instead of a login."

### What you can ask for

- **One task** — "Use Claude Code to fix the failing tests."
- **Several tasks at once** — "Use Codex to add the login page, and Claude Code
  to write the tests." Each runs on its own copy of the project and is merged
  back when done.
- **A specific model or effort** — you can also name a model, or ask it to think
  harder.

### Manual or automatic

By default, nothing happens without you: if Claude Code or Codex has a question,
it asks you, right in the chat.

To let it work more on its own, type `/cli auto decide on` (it answers its own
questions), `/cli auto continue on` (it keeps going through remaining work), and
`/cli auto review on` (it checks the finished work). Use `off` instead of `on`
to undo any of them.

### Watching and steering

Everything runs live in the conversation — every command, every file change.
While it runs you can answer its questions, tell it what to do next, or stop it.

### Where the work goes

One task runs right in your project. Several at once each run on their own copy
(a git branch) and are merged back when done. If two changes touch the same
line, nothing is lost — you are told there is a conflict to resolve.

### Doing it yourself (optional)

You never need to. But typing `/cli` shows what's ready and your accounts, and
`/cli login claude personal` and `/cli auto` let you drive it by hand if you
prefer.

---

## Support

`dsh-cli-bridge` is **free to use** and funded by the people it saves money. If
it keeps the Claude Code / Codex bill off your own, sponsor it.

<p align="center">
  <a href="https://github.com/sponsors/hviana">
    <img src="https://img.shields.io/github/sponsors/hviana?label=sponsor&color=db61a2&logo=github&style=for-the-badge" alt="Sponsor hviana on GitHub" />
  </a>
</p>

- **Use it freely** — personally or commercially, with your own modifications.
- **Sponsor to redistribute** — publishing, forking, or offering it as a service
  is the one paid gate (a sponsorship or a commercial licence).
- **Contribute** — the project stays source-available while its author can still
  license it commercially. See [LICENSE](./LICENSE) and
  [CONTRIBUTING](./CONTRIBUTING.md).

---

## Licence

[Source-available](./LICENSE) — © 2026 hviana. Free to use, funded by sponsors,
redistribution gated. The inlined open-source components keep their own
licences; see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

---

<div align="center">

**[Source-available](./LICENSE)** &nbsp;·&nbsp; © 2026 hviana &nbsp;·&nbsp;
[sponsor](https://github.com/sponsors/hviana) &nbsp;·&nbsp;
[third-party notices](./THIRD-PARTY-NOTICES.md)
<br/> built for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

</div>
