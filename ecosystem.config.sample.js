module.exports = {
    apps: [
        {
            name: "cwa24",
            script: "src/index.js",
            env: {
                NODE_ENV: "production",
                PORT: 3000,
                COGNITO_REGION: "eu-central-1",
                COGNITO_USER_POOL_ID: "eu-central-1_FGuEMHRmT",
                COGNITO_CLIENT_ID: "3pb6qu43hq57i1q6lup0fp25sk",
                //COGNITO_CLIENT_SECRET: "",
                COGNITO_DOMAIN: "https://eu-central-1fguemhrmt.auth.eu-central-1.amazoncognito.com",
                COGNITO_REDIRECT_URI: "https://cwa24.de/landing",
                APP_BASE_URL: "https://cwa24.de",
                SESSION_SECRET: "your-prod-session-secret",
                // PostgreSQL
                DB_HOST: "localhost",                // oder RDS Endpoint
                DB_PORT: 5432,
                DB_NAME: "cwa24_prod",
                DB_USER: "cwa24user",
                //DB_PASSWORD: "...",
                // S3

  
                AWS_REGION: "eu-central-1",
                S3_BUCKET: "cwa24bucketdev"                
            }
        },
        {
            name: "migrate",
            script: "src/migrate.js",
            autorestart: false,
            env: {
                NODE_ENV: "production",
                // PostgreSQL
                DB_HOST: "localhost",                // oder RDS Endpoint
                DB_PORT: 5432,
                DB_NAME: "cwa24_prod",
                DB_USER: "cwa24user"
                //DB_PASSWORD: ""
            }
        }
    ]
};