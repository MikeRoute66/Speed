#!/usr/bin/env python3
import re
from pathlib import Path
p = Path(__file__).parent.parent / 'carSpecs.js'
s = p.read_text()
# Replace variant: "'NN" (possibly with trailing comma) with variant: ""
new = re.sub(r"variant: \"'\d{2}\",", 'variant: "",', s)
# Also handle cases where there's no trailing comma (unlikely)
new = re.sub(r"variant: \"'\d{2}\"", 'variant: ""', new)
out = Path(__file__).parent.parent / 'carSpecs.new.js'
out.write_text(new)
print('Wrote', out)
