-- Active: 1776861341281@@127.0.0.1@5432@cwa24_dev
UPDATE gps_segment_best_efforts AS b
SET avg_speed = ROUND(((s.distance * 3.6) / b.duration)::numeric, 1)::double precision
FROM gps_segments AS s
WHERE s.id = b.sid
  AND s.distance IS NOT NULL
  AND s.distance > 0
  AND b.duration > 0;
