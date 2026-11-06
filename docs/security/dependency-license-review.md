# Dependency license review (internal, incomplete)

Generate the reproducible metadata inventory from the current lockfile:

```sh
node scripts/dependency-license-inventory.mjs > /tmp/cm-dependency-licenses.json
node scripts/dependency-license-inventory.mjs --check
```

`--check` exits 1 while manual-review items exist, 2 on a malformed/missing
lockfile. It is opt-in, not a false green compliance gate. Fixtures:
`node scripts/test-dependency-license-inventory.mjs`.

This is an inventory, not a legal opinion or approval. The repository's own
LICENSE does not replace dependencies' licenses. Development dependencies
still need consideration when code/assets are copied into build output.

## What remains before claiming compliance

- Inspect the original license/notice files for each shipped dependency,
  including transitive dependencies and bundled assets. Lockfile metadata
  alone is not proof of the terms.
- Resolve UNKNOWN, SEE LICENSE, ambiguous identifiers, FSL, MPL and compound
  expressions. An OR expression is not automatically a choice already made.
- Determine which code/assets actually ship and record obligations and
  evidence. Keep required copyright notices, license texts and attribution
  with the distribution as applicable.
- Have the owner or legal reviewer record decisions and any exceptions.
  This checklist grants no license rights and waives no obligations.
- Regenerate after lockfile changes; a previous review does not cover new
  versions. Do not add broad allowlists merely to make the report green.

The report groups common exact permissive identifiers as `notice-review`,
not `approved`: their notice obligations remain unchecked. All other terms
are `manual-review`. No external terms are inferred or fetched by the script.
