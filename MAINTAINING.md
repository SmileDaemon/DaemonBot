# Maintaining DaemonBot

How to keep the bot healthy. [README.md](README.md) covers setup and the commands.

## Housekeeping

`npm start` proves very little: a command whose file imports something that no longer exists only fails when that command loads, and a button with no handler only fails when someone clicks it. `scripts/sweep.js` checks everything else:

```bash
npm run sweep
```

It needs only Node and never contacts Discord. It prints OK or FAIL for each check and exits non-zero if anything fails. It checks:

- **the code:** every file parses; every import points at a file that exists, and every name imported is one that file exports; every export is used somewhere (these are candidates to review, not verdicts); every command file exports `{ data, execute }`, builds a valid definition and has a name of its own; every button and form custom ID names a command with a `handleButton` / `handleModal`; no `debugger`, `console.debug` or TODO left in `src/`; no stray control characters.
- **the settings and the docs:** every `process.env` setting the code reads is in `.env.example`, and the reverse; your `.env` (if there is one) has a token, an application ID and every setting; `lavalink/application.yml` and `.env.example` agree on the port and password; every command appears in the README; every npm script and every relative link in the docs points at a file that exists.
- **the data:** every file in `data/` is valid JSON and filed under server IDs; each word list names each entry once and blocks no ordinary word (raccoon, Scunthorpe, Japanese, retardant, and so on).
- **safety:** no bot token and no personal email address in any file outside `.env`; `.gitignore` keeps `.env`, `data/` and `node_modules/` out of git.
- **leftovers:** Lavalink logs older than 30 days, temporary files in `data/`, and crash logs. These are listed but don't fail the run. To delete them:

  ```bash
  npm run sweep -- --clean
  ```

  `--clean` never touches code, settings or the data files themselves.

Run it after any change, and especially after hand-editing a word list or `.env`. **To add a rule**, write a `check(name, bad)` in the right section of the script. Give it a name that says what should be true, and pass a list of what isn't.

## Safeguards

### Pre-push hook

`.githooks/pre-push` runs before anything leaves this machine and refuses a push that would delete a branch on the remote, or one where the sweep fails. It only applies once the folder is a git repository. Hooks aren't carried by `git clone`, so enable them once per copy:

```bash
git config --local core.hooksPath .githooks
```

To push a deliberate exception:

```bash
ALLOW_DESTRUCTIVE=1 git push
```

### Backups

`data/` holds every server's settings, warnings and tickets, and is not in git. Copy it somewhere safe before moving hosts or upgrading. If the sweep reports a broken data file, restore that file from a backup: the bot won't start with it.
