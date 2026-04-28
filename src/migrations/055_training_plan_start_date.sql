ALTER TABLE training_plans
ADD COLUMN IF NOT EXISTS plan_start_date DATE NULL;
