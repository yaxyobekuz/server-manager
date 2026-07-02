import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT) || 4500,
  adminPassword: process.env.ADMIN_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  // Absolute path to the project root (one level up from /server)
  rootDir: path.join(__dirname, '..', '..'),
  dataDir: path.join(__dirname, '..', 'data'),
  clientDist: path.join(__dirname, '..', '..', 'client', 'dist'),
  // Where managed projects live: <projectsRoot>/<project>/<service>
  projectsRoot: process.env.PROJECTS_ROOT || '/var/www',
};

if (!config.adminPassword) {
  console.warn(
    '[config] ADMIN_PASSWORD is not set — login will be disabled. Copy server/.env.example to server/.env and set it.'
  );
}
