# @revxz/dsh-mcp-evolve

**Reserved. Not implemented.**

This package exists so that MCP evolution can be added later without splitting
anything again. It is published as a name reservation, not as a working plugin.

## What it does today

Loads, then throws:

```
Error: @revxz/dsh-mcp-evolve is a reserved placeholder and is not implemented yet
```

That is deliberate. Publishing a package that registers a plugin and then does
nothing would put a line in a user's profile that they cannot remove without
wondering what broke. A load-time error with a reason is honest; silence that
looks like success is not.

**Do not add it to a profile.** It will fail to start.

## Why a placeholder rather than nothing

The shared engine (`@revxz/dsh-evolve-core`) already owns the pieces an MCP
lifecycle would need:

| piece | module | what an MCP evolution would use it for |
| --- | --- | --- |
| serialized store | `store.js` | one queue file, two plugins writing to it |
| proposal queue with staleness | `candidates.js` | proposed MCP server configs, expiring the same way |
| evidence gate | `evidence.js` | "did the tool actually fail, and can we quote it" |
| aging ledger | `outcome.js` | observing whether an MCP server helped after it was loaded |
| ownership marker + file format | `skillfile.js` | the same pattern, a different file |

Every one of them is written against "a name plus a body", not against skills
specifically. That is what makes this reservation real rather than aspirational:
the work that would be duplicated by a later split has already been factored
out.

## What it would need to be implemented

Not written down in detail yet, on purpose — a plan for a package nobody has
scoped would be speculation. The known unknowns:

- MCP servers are configured in the profile, not in a directory of files, so the
  write path is different from `SKILL.md` and would need its own `skillfile`
  equivalent
- an MCP server's "body" is a command line plus env, which raises the question
  of what a proposed revision even means
- the evidence for "this server was useful" is tool-call outcomes attributed to a
  server, which the outcome window already records by name

## Tests

None. The only assertion that could exist — that `apply()` throws — is not worth
a suite until there is a second thing to compare against.

## License

MIT
