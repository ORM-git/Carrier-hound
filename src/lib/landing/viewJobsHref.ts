/** Guest "View Jobs" CTAs go through signup first. /signup and /login already send signed-in users on
 *  (onboarding when incomplete, otherwise the validated `next` target), and guests who sign in land on /jobs. */
export const VIEW_JOBS_AUTH_HREF = "/signup?next=%2Fjobs";
