import { getOperationalStatus } from '@under-review/core/repository';
export async function GET(){const status=await getOperationalStatus();return Response.json({ready:status.database},{status:status.database?200:503,headers:{'Cache-Control':'no-store'}});}
