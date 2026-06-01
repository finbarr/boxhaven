# Contributing to BoxHaven

## Development

```bash
git clone https://github.com/finbarr/boxhaven.git
cd boxhaven
make build
make test
```

The CLI entrypoint is [cmd/bh](cmd/bh). The backend lives in [backend](backend).

## Checks

Run before opening a pull request:

```bash
make clean && make build && make test
make lint
npm --prefix backend run build
```
