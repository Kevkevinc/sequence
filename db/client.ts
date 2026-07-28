import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getRequiredEnv } from '@/lib/env';
import * as schema from './schema';

const queryClient = postgres(getRequiredEnv('DATABASE_URL'));
export const db = drizzle(queryClient, { schema });
