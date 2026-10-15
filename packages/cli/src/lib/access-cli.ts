import type { Command } from "commander";

export function registerAccessCommands(program: Command): void {
  program
    .command("access <operation> [principalId] [deviceName]")
    .description(
      "Local access administration: initialize, setup, reset, list, device, origin, origins",
    )
    .action(
      async (
        operation: string,
        principalId: string | undefined,
        deviceName: string | undefined,
      ) => {
        const args = [operation, principalId, deviceName].filter(
          (value): value is string => value !== undefined,
        );
        let database: { $disconnect(): Promise<void> } | undefined;
        try {
          if (operation === 'origins') {
            if (principalId || deviceName) throw new Error('Use access origins without arguments');
            const { accessOrigins } = await import('../../../../apps/web/src/lib/sidedoor/access/network/configuration');
            const { prisma } = await import('@/lib/prisma');
            database = prisma;
            const config = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { publicBaseUrl: true } });
            const { FlightFinderAccessStore } = await import('../../../../apps/web/src/lib/sidedoor/access/access-store');
            const policy = await new FlightFinderAccessStore().admissionPolicy();
            console.log(JSON.stringify({ ...accessOrigins(config?.publicBaseUrl), hasOwner: policy.hasOwner,
              canonicalConfigured: Boolean(config?.publicBaseUrl || process.env.APP_URL) }));
            return;
          }
          if (operation === 'origin') {
            if (!principalId || deviceName) throw new Error('Use access origin <http(s)://hostname[:port]>');
            const { accessOrigin } = await import('../../../../apps/web/src/lib/sidedoor/access/network/configuration');
            const publicBaseUrl = accessOrigin(principalId);
            const { prisma } = await import('@/lib/prisma');
            database = prisma;
            await prisma.extractionConfig.upsert({
              where: { id: 'singleton' }, create: { id: 'singleton', publicBaseUrl }, update: { publicBaseUrl },
            });
            console.log(`Access origin configured: ${publicBaseUrl}. Open this address to sign in. Additional addresses require SIDEDOOR_PASSWORD_ORIGINS.`);
            return;
          }
          if (!['initialize', 'setup', 'reset', 'list', 'device', 'prepare', 'finalize'].includes(operation))
            throw new Error('Use access initialize, setup, reset, list, device, or origin.');
          if (operation === "prepare" || operation === "finalize") {
            if (args.length !== 1)
              throw new Error(`Use access ${operation}.`);
            const { prisma } = await import("@/lib/prisma");
            database = prisma;
            const cutover = await import(
              "../../../../apps/web/src/lib/sidedoor/migration/platform-cutover"
            );
            console.log(
              JSON.stringify(
                operation === "prepare"
                  ? await cutover.preparePlatformCutover()
                  : await cutover.finalizePlatformCutover(),
              ),
            );
            return;
          }
          const {
            AccessService,
            DeviceService,
            executeAccessCommand,
            parseAccessCommand,
            readLocalSetupInput,
            readLocalResetInput,
          } = await import("thesidedoor-core/access");
          parseAccessCommand(args);
          const { prisma } = await import("@/lib/prisma");
          database = prisma;
          const { FlightFinderAccessStore } =
            await import("../../../../apps/web/src/lib/sidedoor/access/access-store");
          const store = new FlightFinderAccessStore();
          const access = new AccessService({ store });
          console.log(
            await executeAccessCommand(access, args, {
              initialize: async () => {
                await store.initialize();
                return { warnings: [] };
              },
              setupInput: readLocalSetupInput,
              resetInput: readLocalResetInput,
              devices: {
                service: new DeviceService({
                  access,
                  scopesFor: () => ["api"],
                  tokenPrefix: "ff_",
                }),
                scopes: ["api"],
              },
            }),
          );
        } catch (error) {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        } finally {
          await database?.$disconnect();
        }
      },
    );
}
