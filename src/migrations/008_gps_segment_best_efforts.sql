DROP TABLE IF EXISTS gps_segment_best_efforts cascade;

CREATE TABLE gps_segment_best_efforts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sid             BIGINT NOT NULL,
    wid             BIGINT NOT NULL,
    start_offset    INTEGER NOT NULL,
    end_offset      INTEGER NOT NULL,
    duration        INTEGER NOT NULL,
    avg_power       DOUBLE PRECISION NOT NULL,
    avg_heart_rate  DOUBLE PRECISION,
    avg_cadence     DOUBLE PRECISION,
    avg_speed       DOUBLE PRECISION,  
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT fk_gps_segments
        FOREIGN KEY (sid)
        REFERENCES gps_segments(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_workout
        FOREIGN KEY (wid)
        REFERENCES workouts(id)
        ON DELETE CASCADE,

    CONSTRAINT unique_segment_effort
        UNIQUE (sid, wid, start_offset, end_offset)

);


CREATE TRIGGER trigger_set_updated_at
BEFORE UPDATE ON gps_segment_best_efforts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
