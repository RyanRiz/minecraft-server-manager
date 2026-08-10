'use strict';

// Shared "Advanced Docker Settings" fields, spread into every request schema
// that can create or update a server (wizard, from-pack, from-mods, blueprint
// import, PATCH /api/servers/:id) so the 4 new knobs aren't redefined 5 times.
// Shape validation only — existence/collision checks run server-side in
// services/dockerSpec.js#validateOverrides, since those need async Docker/DB
// calls a zod schema can't make.

const { z } = require('zod');

const dockerOverridesSchema = {
  // '' is accepted (and only meaningful in a PATCH) as "clear it, go back to msm-<id>".
  containerName: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(63)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .optional(),
  networkName: z.string().trim().max(128).optional(),
  extraPorts: z
    .array(
      z.object({
        hostPort: z.coerce.number().int().min(1024).max(65535),
        containerPort: z.coerce.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']),
        label: z.string().trim().max(40).optional(),
      })
    )
    .max(20)
    .optional(),
  extraBinds: z
    .array(
      z.object({
        hostPath: z.string().trim().min(1).max(500),
        containerPath: z.string().trim().min(1).max(300),
        mode: z.enum(['rw', 'ro']).optional(),
      })
    )
    .max(20)
    .optional(),
};

module.exports = { dockerOverridesSchema };
