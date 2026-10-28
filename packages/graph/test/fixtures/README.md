# External quality producer fixture

`ruff-0.17.3.sarif.json` comes from an actual Ruff 0.17.3 Windows scan of this
first-party two-line file (never executed):

```python
import os
print(missing)
```

Command: `ruff check --isolated --select F401,F821 --output-format sarif --no-cache sample.py`.
Expected before import: F401 at line 1, column 8; F821 at line 2, column 7.
Exit 1 denotes lint findings. The captured absolute URI is replaced with `sample.py`
in both locations and fixes; driver documentation is removed. Result messages/fixes
remain so the tests can prove they are discarded, rather than accidentally displayed.
An independent physical check also imports the original absolute-URI report with an
explicit source root (ADR-085). Tool archive hash is recorded in that ADR.
