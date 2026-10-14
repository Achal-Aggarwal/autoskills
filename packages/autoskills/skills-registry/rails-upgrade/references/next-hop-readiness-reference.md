# Next-Hop Readiness Reference

**When to read this:** the user asks what stands between the app and the next Rails version ("what do I need to get to the next Rails version?"). A quick, read-only answer from the app's files, not an upgrade.

## Rules

- **One hop**: the next version the guides plan from the current one (`upgrade-<current>-to-*.md`). Never list what later versions remove. If the user names a farther target, say this covers the next hop on the way.
- **Read-only**: no Gemfile edits, no `bundle install`, no next_rails setup, no test suite, no fixes.
- **Only what ran**: what the steps cannot see goes under "Not checked".

## Steps

1. **Patch**: `workflows/00-verify-latest-patch-workflow.md` Steps 1 and 2. Report it, do not block.
2. **Gems**: `ruby <skill>/detection-scripts/gem_limits.rb` lists the locked gems whose gemspec excludes the next hop. If next_rails is already in the bundle, `bundle exec bundle_report compatibility --rails-version=<target>` adds the version to bump to. If `Gemfile.next.lock` already pins the target, the gem side is resolved: say so instead of listing caps.
3. **Code**: `ruby <skill>/detection-scripts/scan_patterns.rb --summary`. It names the same hop as step 2. If that hop has no patterns file, search by hand from its version guide, as `workflows/05-detect-breaking-changes-workflow.md` does, and say so. Read one site of each HIGH finding before listing it (`workflows/05-detect-breaking-changes-workflow.md` Step 3).

## Answer

No workflow numbers or skill paths.

```markdown
## Rails {CURRENT} → {TO}: what stands in the way

**Patch:** on the latest {X.Y} patch / upgrade to {X.Y.W} first.
**Gems capped below {TO}** ({N}): gem, locked version, limit, parent if not in the Gemfile. Or "None".
**Fix before the bump** ({N} patterns): one line each, HIGH first, with a site count and one file:line.
**Fix when ready** ({N} patterns): one line each.
**Not checked:** the test suite and its deprecation warnings, boot on {TO}, behavior no pattern can find.
```

End with one offer: start the upgrade to {TO} (a Full Upgrade, from Workflow 00).
