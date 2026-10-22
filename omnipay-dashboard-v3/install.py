#!/usr/bin/env python3
from pathlib import Path
import shutil, sys
source=Path(__file__).resolve().parent
project=Path.cwd(); public=project/'public'; public.mkdir(exist_ok=True)
for name in ['dashboard-v3.html','dashboard-v3.js']:
    target=public/name
    if target.exists(): shutil.copy2(target, public/(name+'.bak'))
    shutil.copy2(source/name,target)
print('DASHBOARD_V3_INSTALLE')
print('TEST: node --check public/dashboard-v3.js')
print('LOCAL: http://localhost:3000/dashboard-v3.html')
