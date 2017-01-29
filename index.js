"use strict";

const co = require('co');
const duniter = require('duniter');
const http      = require('http');
const express   = require('express');

/****************************************
 * TECHNICAL CONFIGURATION
 ***************************************/

// Default Duniter node's database
const HOME_DUNITER_DATA_FOLDER = 'wotex';

// Default host on which WoT UI is available
const DEFAULT_HOST = 'localhost';

// Default port on which WoT UI is available
const DEFAULT_PORT = 8558;

/****************************************
 * SPECIALIZATION
 ***************************************/

const stack = duniter.statics.autoStack([{
  name: 'wotex',
  required: {

    duniter: {

      cli: [{
        name: 'wotex [host] [port]',
        desc: 'Starts WoT node',

        // Disables Duniter node's logs
        // logs: false,

        onDatabaseExecute: (duniterServer, conf, program, params, startServices) => co(function*() {

          /****************************************
           * WHEN DUNITER IS LOADED, EXECUTE WOT
           ***************************************/
          const SERVER_HOST = params[0] || DEFAULT_HOST;
          const SERVER_PORT = parseInt(params[1]) || DEFAULT_PORT;

        /****************************************
         * SPECIALISATION
         ***************************************/

        const app = express();
        const constants = duniterServer.lib.constants;

        /**
         * Sur appel de l'URL /bloc_courant
         */
        app.get('/', (req, res) => co(function *() {

          try {
            // Trouve les points de contrôle efficacement grâce au module C (nommé "wotb")
            const head = yield duniterServer.dal.getCurrentBlockOrNull();
            const membersCount = head ? head.membersCount : 0;
            let dSen;
            if (head.version <= 3) {
              dSen = Math.ceil(constants.CONTRACT.DSEN_P * Math.exp(Math.log(membersCount) / duniterServer.conf.stepMax));
            } else {
              dSen = Math.ceil(Math.pow(membersCount, 1 / duniterServer.conf.stepMax));
            }
            const pointsDeControle = duniterServer.dal.wotb.getSentries(dSen);
            const sentries = yield pointsDeControle.map((wotb_id) => co(function*() {
              return (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wotb_id = ?', [wotb_id]))[0];
            }));

            let searchResult = '';
            if (req.query.to) {
              const idty = (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wasMember AND (uid = ? or pub = ?)', [req.query.to, req.query.to]))[0];
              if (!idty) {
                searchResult = `
              <p>UID or public key « ${req.query.to} » is not a member and cannot be found in the WoT.</p>
            `;
              } else {

                const dicoIdentites = yield donneDictionnaireIdentites(duniterServer);
                let lignes = [];
                for (const sentry of sentries) {
                  const plusCourtsCheminsPossibles = duniterServer.dal.wotb.getPaths(sentry.wotb_id, idty.wotb_id, duniterServer.conf.stepMax);
                  if (plusCourtsCheminsPossibles.length) {
                    lignes.push(traduitCheminEnIdentites(plusCourtsCheminsPossibles, dicoIdentites));
                  } else {
                    if (idty.uid != sentry.uid) {
                      lignes.push([idty.uid, '?', sentry.uid]);
                    }
                  }
                }

                lignes.sort((ligneA, ligneB) => {
                  if (ligneA.length > ligneB.length) return -1;
                if (ligneB.length > ligneA.length) return 1;
                if ((ligneA[1] && ligneA[1] == '?') && (!ligneB[1] || ligneB[1] != '?')) {
                  return 1;
                }
                if ((ligneB[1] && ligneB[1] == '?') && (!ligneA[1] || ligneA[1] != '?')) {
                  return -1;
                }
                return 0;
              });
                lignes.reverse();

                const chemins = lignes.map((colonnes) => {
                    return `
                <tr>
                  <td>${colonnes[0] || ''}</td>
                  <td>${colonnes[1] ? '<-' : ''}</td>
                  <td>${colonnes[1] || ''}</td>
                  <td>${colonnes[2] ? '<-' : ''}</td>
                  <td>${colonnes[2] || ''}</td>
                  <td>${colonnes[3] ? '<-' : ''}</td>
                  <td>${colonnes[3] || ''}</td>
                  <td>${colonnes[4] ? '<-' : ''}</td>
                  <td>${colonnes[4] || ''}</td>
                  <td>${colonnes[5] ? '<-' : ''}</td>
                  <td>${colonnes[5] || ''}</td>
                </tr>
              `;
              }).join('');

                searchResult = `
              <table>
                <tr>
                  <th>Step 0</th>
                  <th class="arrow"><-</th>
                  <th>Step 1</th>
                  <th class="arrow"><-</th>
                  <th>Step 2</th>
                  <th class="arrow"><-</th>
                  <th>Step 3</th>
                  <th class="arrow"><-</th>
                  <th>Step 4</th>
                  <th class="arrow"><-</th>
                  <th>Step 5</th>
                </tr>
                ${chemins}
              </table>
            `;
              }
            }

            // Générons un contenu de page à afficher
            let sentriesHTML = sentries
                .map((sentry) => `
            <div class="sentry">${sentry.uid}</div>
          `)
          .join('');
            let contenu = `
          <html>
            <head>
              <style>
                body {
                  font-family: "Courier New", sans-serif;
                }
                .sentry {
                  float: left;
                  width: 200px;
                  height: 21px;
                  overflow: hidden;
                }
                .arrow {
                  width: 50px;
                }
                td {
                  text-align: center;
                }
              </style>
            </head>
            <body>
              <h1>wotb explorer</h1>
              <form method="GET" action="/">
                <div>
                  <label for="to">Test UID:</label>
                  <input type="text" name="to" id="to">
                </div>
              </form>
              ${searchResult}
              <h2>Current sentries:</h2>
              ${sentriesHTML}
            </body>
          </html>
        `;
            // Envoyons la réponse
            res.status(200).send(contenu);
          } catch (e) {
            // En cas d'exception, afficher le message
            res.status(500).send('<pre>' + (e.stack || e.message) + '</pre>');
          }

        }));

        const httpServer = http.createServer(app);
        httpServer.listen(SERVER_PORT, SERVER_HOST);
        console.log("Serveur web disponible a l'adresse http://%s:%s", SERVER_HOST, SERVER_PORT);

        yield startServices();
        /****************************************/

          // Wait forever, WoT is a permanent program
          yield new Promise(() => null);
        })
      }]
    }
  }
}]);

function donneDictionnaireIdentites(duniterServer) {
  return co(function*() {
    const dico = {};
    const identites = yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wotb_id IS NOT NULL');
    for (const identite of identites) {
      dico[identite.wotb_id] = identite;
    }
    return dico;
  });
}

function traduitCheminEnIdentites(chemins, dicoIdentites) {
  const cheminsTries = chemins.sort((cheminA, cheminB) => {
      if (cheminA.length < cheminB.length) {
    return -1;
  }
  if (cheminA.length > cheminB.length) {
    return 1;
  }
  return 0;
});
  if (cheminsTries[0]) {
    const inverse = cheminsTries[0].slice().reverse();
    return inverse.map((wotb_id) => dicoIdentites[wotb_id].uid);
  } else {
    return [];
  }
}


co(function*() {
  if (!process.argv.includes('--mdb')) {
    // We use the default database
    process.argv.push('--mdb');
    process.argv.push(HOME_DUNITER_DATA_FOLDER);
  }
  // Execute our program
  yield stack.executeStack(process.argv);
  // End
  process.exit();
});
