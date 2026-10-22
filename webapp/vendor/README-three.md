`three-bundle.min.js`: three.js r186 (0.186.1, MIT, see LICENSE-three) with
OrbitControls, EffectComposer, RenderPass, UnrealBloomPass and OutputPass,
bundled as one script that sets `window.THREE`. Rebuild:

```bash
npm i three@0.186.1 esbuild@0.28.2
cat > entry.js <<'JS'
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
window.THREE = Object.assign({}, THREE, { OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass });
JS
npx esbuild entry.js --bundle --minify --format=iife --legal-comments=none --outfile=three-bundle.min.js
```
