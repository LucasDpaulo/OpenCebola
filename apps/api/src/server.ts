import { buildApp } from "./app.js";
import { createApplicationDependencies } from "./composition.js";
import { readEnvironment } from "./env.js";

const environment = readEnvironment();
const app = await buildApp(environment, createApplicationDependencies(environment));

try {
  await app.listen({
    host: environment.CEBOLA_API_HOST,
    port: environment.CEBOLA_API_PORT
  });
} catch (error) {
  app.log.error(error, "Falha ao iniciar a API do Cebola");
  process.exit(1);
}
