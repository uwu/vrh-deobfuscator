# vrh-deobfuscator
An automatic downloader and deobfuscator for VRoid Hub models.
For educational use only. I'll get really mad if you don't use it for educational reasons.

# Usage
Are you sure you should be using this?

# Usage, but like, actually
```bash
# Install dependencies
pnpm install
# Run with a URL for things you want to legally obtain
node src/index.js https://hub.vroid.com/en/characters/6687678955411994848/models/3497471223710880744
```

# Troubleshooting
gltf-transform does some things to every model that breaks them when used as a VRM, so the tool automatically patches each model up for usage as a VRM.

To resolve most issues, simply take the resulting VRM and throw it into Blender or Unity (w/ either version of the VRM extension) and re-export a new VRM from there. Ensure you've tried both versions of the Unity extension & Blender before submitting an issue.


# Relevant blog post
[You can read more about this here, if you even care.](https://toon.link/blog/1740863435/borrowing-intellectual-property)
