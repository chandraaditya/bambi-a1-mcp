# Third-party components

This project is licensed under GPL-2.0-only. It integrates the following separately maintained components through dependencies or installed runtimes:

- [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp), by David Montgomery and contributors, GPL-2.0. Version 1.1.51 supplies the slicing, bridge protocol, AMS mapping and print-file/printer-state validation libraries. No claim of authorship over those components is made.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT.
- [Ajv](https://github.com/ajv-validator/ajv), MIT.
- [MQTT.js](https://github.com/mqttjs/MQTT.js), MIT.

See the installed packages for their complete notices and transitive dependency licenses.

`src/vendor/printer-state.mjs` is derived from David Montgomery and contributors' GPL-2.0 printer-state validator in `bambu-printer-mcp` 1.1.51 (`dist/safety/printer-state.js`, original SHA-256 `f495d95a1ec33c3323ff813dc5708eeca66d7c6830e4d9bf8da49dd42f652289`). Local changes omit the unused MQTT reader, adjust dependency imports, and add an explicitly acknowledged A1 terminal-job recovery condition. The original identity, freshness, HMS, nozzle and material checks remain. Recovery never rewrites telemetry or sends a fault-clearing command. This copy is included so the change is reviewable and reproducible without modifying installed dependencies; compare it with the pinned upstream source when updating that dependency.

The FULU bridge runtime and Bambu Lab's proprietary networking plug-in are installed separately. This repository does not redistribute their binaries. Bambu Studio is a separate application and remains subject to its own licenses. This is an independent integration, unaffiliated with Bambu Lab.
