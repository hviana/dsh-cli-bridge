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

The built-in delegates hand you the final result. This one hands you the whole
run.

[![npm](https://img.shields.io/npm/v/dsh-cli-bridge?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-cli-bridge)
[![ci](https://github.com/hviana/dsh-cli-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hviana/dsh-cli-bridge/actions/workflows/ci.yml)
[![source-available](https://img.shields.io/badge/licence-source--available-8b5cf6)](./LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-5a67d8)](https://github.com/topics/dsh-plugin)
[![sponsor](https://img.shields.io/github/sponsors/hviana?label=sponsor&color=db61a2&logo=github)](https://github.com/sponsors/hviana)

</div>

---

## What it does

**One tool call from DeepSeek Harness. A real agent doing real work — on screen,
in real time, under your control.**

`dsh-cli-bridge` delegates work to **Claude Code** and **Codex**, then keeps you
and DeepSeek Harness in the loop for the entire run:

| **📺 Watch it live**                                                                                                            | **🧠 Give DSH the wheel**                                                                                                                              | **🛠️ Nothing to set up**                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Every tool call, every file changed, every line of reasoning streams into DSH as it happens — not a spinner, not a final paste. | DeepSeek Harness can steer, answer, and review the delegate's work on its own, round after round — or hand you the question when it should not decide. | The plugin finds, installs, and updates Claude Code and Codex itself. You install one plugin; it manages the rest. |

> [!IMPORTANT]
> **Why this exists** — the built-in `claude` and `codex` delegates call the CLI
> like a tool and return only the final message. The whole run happens in the
> dark, and the transcript costs you tokens twice. `dsh-cli-bridge` puts the run
> on screen, keeps the transcript out of your model's context, and gives the
> harness the controls.

---

## The difference

| A built-in delegate call                    | ✨ `dsh-cli-bridge`                                           |
| ------------------------------------------- | ------------------------------------------------------------- |
| ❌ hands back only the final result         | ✅ the whole run, streamed live into DSH                      |
| ❌ DeepSeek just reads the answer           | ✅ DeepSeek steers, answers, and reviews the delegate         |
| ❌ you install and update the CLIs yourself | ✅ the plugin installs and updates them                       |
| ❌ one login, configured by hand            | ✅ many isolated accounts, side by side                       |
| ❌ tasks share one workspace                | ✅ a git worktree per task, merged back automatically         |
| ❌ Claude Code talks to Anthropic only      | ✅ Claude Code + Codex, and any Anthropic-compatible endpoint |

---

## And the rest

The headline is the live run. The rest is what makes it safe to let an agent
loose on a repository:

- **👥 Multi-account, isolated** — every account is a directory; each login
  lives in its own home and never touches another.
- **🌐 Any endpoint** — Claude Code can reach DeepSeek, OpenRouter, or any
  Anthropic-compatible provider, by base URL + token.
- **🌿 Worktrees & automatic merge** — parallel tasks each get their own branch;
  finished work merges back `--no-ff`, one at a time, conflicts kept for you.
- **🧭 A deterministic hand-back** — the delegate states when it needs a
  decision, and the protocol is fixed rather than guessed from prose.
- **🔒 Inherited permissions** — the harness's own Read Only / Workspace Write /
  Full Access mode is the whole policy; the plugin invents none.
- **⚙️ Model & effort per call** — each delegation names its own model and
  effort, or inherits sensible defaults.

---

## Install

```sh
dsh plugin --profile web add dsh-cli-bridge
```

> [!NOTE]
> **Scaffold** — this is the published-plugin install path, kept here as a
> placeholder to be finalized after the next publication.

---

## Support

`dsh-cli-bridge` is **free to use** and funded by the people it saves money. If
it keeps delegate spend off your model bill, sponsor it.

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
