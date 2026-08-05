SELECT json_build_object(
  'database', current_database(),
  'adminPresent', EXISTS (
    SELECT 1
    FROM users u
    JOIN user_roles r ON r.uid = u.id AND r.role = 'admin'
    WHERE u.auth_sub = :'admin_auth_sub'
  ),
  'users', (SELECT count(*) FROM users),
  'workouts', (SELECT count(*) FROM workouts),
  'segments', (SELECT count(*) FROM gps_segments)
)::text;
