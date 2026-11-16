-- Keep score-policy reads behind the backend, including on databases with
-- default grants for Supabase's browser roles.
ALTER VIEW public.athlete_score_policy SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON TABLE public.athlete_score_policy FROM PUBLIC;
DO $$
DECLARE actor text;
BEGIN
  FOREACH actor IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = actor) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.athlete_score_policy FROM %I', actor);
    END IF;
  END LOOP;
END $$;
