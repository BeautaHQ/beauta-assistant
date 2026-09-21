import { PrismaClient } from "@prisma/client";

/**
 * One client for the whole process, over beauta-api's database.
 *
 * This service never migrates. It reads the salon's details to answer the
 * phone, and writes the record of each call it took. Bookings still go through
 * beauta-api over HTTP — a booking has rules about staff, tasks and
 * confirmation emails that live there, and writing the rows directly would
 * quietly skip every one of them.
 */
export const prisma = new PrismaClient();
