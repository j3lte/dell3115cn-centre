# analyse

Service that looks for the yellow tracking dots a colour laser printer adds to every page, in a scanned page, and
decodes them with [DEDA](https://github.com/dfd-tud/deda). Used by the web app's *Analyse* section.

Licensed GPL-3.0-or-later (see `LICENSE`), because it uses DEDA. The rest of the repository is Apache-2.0 and does
not import from here.

## Tests

```sh
cd analyse && uv run --with pytest pytest -q
```

The tests use generated pages only (fake serial `123456`), never real scans.
