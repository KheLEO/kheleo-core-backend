ALTER TABLE athlete_profiles
    ALTER COLUMN date_of_birth DROP NOT NULL,
    ALTER COLUMN gender DROP NOT NULL,
    ALTER COLUMN primary_sport DROP NOT NULL;
