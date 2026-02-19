const express = require('express');
const app = express();
const request = require('request');
const wikip = require('wiki-infobox-parser');
const multer = require('multer');
const fitParser = require('fit-file-parser');

const upload = multer();



//ejs
app.set("view engine", 'ejs');

//routes
app.get('/', (req,res) =>{
    res.render('index');
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const buffer = req.file.buffer;

    const fitParserInstance = new fitParser();
    fitParserInstance.parse(
        buffer,
        (error, data) => {
            if (error) {
                return res.status(500).send('Error parsing FIT file.');
            }
            // Hier kannst du die Daten weiterverarbeiten, z.B. zurücksenden
            res.json(data);
        }
    );
});

app.get('/index', (req,response) =>{
    let url = "https://en.wikipedia.org/w/api.php"
    let params = {
        action: "opensearch",
        search: req.query.person,
        limit: "1",
        namespace: "0",
        format: "json"
    }

    url = url + "?"
    Object.keys(params).forEach( (key) => {
        url += '&' + key + '=' + params[key]; 
    });

    //get wikip search string
    request(url,(err,res, body) =>{
        if(err) {
            response.redirect('404');
        }
            result = JSON.parse(body);
            x = result[3][0];
            x = x.substring(30, x.length); 
            //get wikip json
            wikip(x , (err, final) => {
                if (err){
                    response.redirect('404');
                }
                else{
                    const answers = final;
                    response.send(answers);
                }
            });
    });

    
});

//port
app.listen(3000, "0.0.0.0", () => { console.log("Listening at port 3000...") } )