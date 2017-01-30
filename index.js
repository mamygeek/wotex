"use strict";

const _ = require('underscore');
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

const MAX_STEP_LOOK = 4;

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
            const wotb = duniterServer.dal.wotb.memcopy();
            wotb.setMaxCert(100);
            const head = yield duniterServer.dal.getCurrentBlockOrNull();
            const membersCount = head ? head.membersCount : 0;
            let dSen;
            if (head.version <= 3) {
              dSen = Math.ceil(constants.CONTRACT.DSEN_P * Math.exp(Math.log(membersCount) / duniterServer.conf.stepMax));
            } else {
              dSen = Math.ceil(Math.pow(membersCount, 1 / duniterServer.conf.stepMax));
            }
            const dicoIdentites = {};
            const pointsDeControle = wotb.getSentries(dSen);
            const sentries = yield pointsDeControle.map((wotb_id) => co(function*() {
              const identite = (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wotb_id = ?', [wotb_id]))[0];
              identite.statusClass = 'isSentry';
              dicoIdentites[identite.wotb_id] = identite;
              return identite;
            }));

            let searchResult = '';
            if (req.query.to) {
              const idty = (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wasMember AND (uid = ? or pub = ?)', [req.query.to, req.query.to]))[0];
              if (!idty) {
                searchResult = `
              <p>UID or public key « ${req.query.to} » is not a member and cannot be found in the WoT.</p>
            `;
              } else {

                if (req.query.mode == "u2w") {

                  // Ajout des membres non-sentries
                  const pointsNormaux = wotb.getNonSentries(dSen);
                  const nonSentries = yield pointsNormaux.map((wotb_id) => co(function*() {
                    const identite = (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wotb_id = ?', [wotb_id]))[0];
                    identite.statusClass = 'isMember';
                    dicoIdentites[identite.wotb_id] = identite;
                    return identite;
                  }));

                  let membres = sentries.concat(nonSentries);

                  const mapPendingCerts = {};
                  const mapPendingIdties = {};
                  if (req.query.pending) {
                    // Recherche les identités en attente
                    const pendingIdties =  yield duniterServer.dal.idtyDAL.sqlListAll();
                    for (const idty of pendingIdties) {
                      // Add it to the temp wot
                      idty.wotb_id = wotb.addNode();
                      console.log('%s is affected wid %s', idty.uid, idty.wotb_id);
                      idty.statusClass = 'isPending';
                      idty.pub = idty.pubkey;
                      dicoIdentites[idty.wotb_id] = idty;
                      mapPendingIdties[idty.wotb_id] = idty;
                    }

                    membres = membres.concat(Object.values(mapPendingIdties));

                    // Recherche les certifications en attente
                    const pendingCerts = yield duniterServer.dal.certDAL.sqlListAll();
                    for (const cert of pendingCerts) {
                      const from = _.findWhere(membres, { pub: cert.from });
                      const target = _.findWhere(membres, { hash: cert.target });
                      if (target && from) {
                        wotb.addLink(from.wotb_id, target.wotb_id);
                        mapPendingCerts[[from.wotb_id, target.wotb_id].join('-')] = true;
                      }
                    }
                  }

                  let lignes = [];
                  for (const membre of membres) {
                    const plusCourtsCheminsPossibles = wotb.getPaths(idty.wotb_id, membre.wotb_id, MAX_STEP_LOOK);
                    if (plusCourtsCheminsPossibles.length) {
                      lignes.push(traduitCheminEnIdentites(plusCourtsCheminsPossibles, dicoIdentites, mapPendingCerts));
                    } else {
                      const identiteObservee = dicoIdentites[idty.wotb_id];
                      if (identiteObservee.uid != membre.uid) {
                        lignes.push([membre, { uid: '?' }, { uid: '?' }, { uid: '?' }, identiteObservee]);
                      }
                    }
                  }

                  wotb.showWoT();

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
                        <td class="${ colonnes[0] && colonnes[0].statusClass }">${ (colonnes[0] && colonnes[0].uid) || ''}</td>
                        <td class="${ colonnes[1] && colonnes[1].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[1] && colonnes[1].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[1] && colonnes[1].statusClass }">${ (colonnes[1] && colonnes[1].uid) || ''}</td>
                        <td class="${ colonnes[2] && colonnes[2].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[2] && colonnes[2].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[2] && colonnes[2].statusClass }">${ (colonnes[2] && colonnes[2].uid) || ''}</td>
                        <td class="${ colonnes[3] && colonnes[3].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[3] && colonnes[3].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[3] && colonnes[3].statusClass }">${ (colonnes[3] && colonnes[3].uid) || ''}</td>
                        <td class="${ colonnes[4] && colonnes[4].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[4] && colonnes[4].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[4] && colonnes[4].statusClass }">${ (colonnes[4] && colonnes[4].uid) || ''}</td>
                        <td class="${ colonnes[5] && colonnes[5].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[5] && colonnes[5].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[5] && colonnes[5].statusClass }">${ (colonnes[5] && colonnes[5].uid) || ''}</td>
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
                        <th>Infinity</th>
                      </tr>
                      ${chemins}
                    </table>
                  `;

                } else {

                  // Ajout des membres non-sentries
                  const pointsNormaux = wotb.getNonSentries(dSen);
                  const nonSentries = yield pointsNormaux.map((wotb_id) => co(function*() {
                    const identite = (yield duniterServer.dal.idtyDAL.query('SELECT * FROM i_index WHERE wotb_id = ?', [wotb_id]))[0];
                    identite.statusClass = 'isMember';
                    dicoIdentites[identite.wotb_id] = identite;
                    return identite;
                  }));

                  let membres = sentries.concat(nonSentries);

                  const mapPendingCerts = {};
                  const mapPendingIdties = {};
                  if (req.query.pending) {
                    // Recherche les identités en attente
                    const pendingIdties =  yield duniterServer.dal.idtyDAL.sqlListAll();
                    for (const idty of pendingIdties) {
                      // Add it to the temp wot
                      idty.wotb_id = wotb.addNode();
                      idty.statusClass = 'isPending';
                      dicoIdentites[idty.wotb_id] = idty;
                      mapPendingIdties[idty.wotb_id] = idty;
                    }

                    membres = membres.concat(Object.values(mapPendingIdties));

                    // Recherche les certifications en attente
                    const pendingCerts = yield duniterServer.dal.certDAL.sqlListAll();
                    for (const cert of pendingCerts) {
                      const from = _.findWhere(membres, { pub: cert.from });
                      const target = _.findWhere(membres, { hash: cert.target });
                      if (target && from) {
                        wotb.addLink(from.wotb_id, target.wotb_id);
                        mapPendingCerts[[from.wotb_id, target.wotb_id].join('-')] = true;
                      }
                    }
                  }

                  let lignes = [];
                  for (const membre of membres) {
                    const plusCourtsCheminsPossibles = wotb.getPaths(membre.wotb_id, idty.wotb_id, MAX_STEP_LOOK);
                    if (plusCourtsCheminsPossibles.length) {
                      lignes.push(traduitCheminEnIdentites(plusCourtsCheminsPossibles, dicoIdentites, mapPendingCerts));
                    } else {
                      const identiteObservee = dicoIdentites[idty.wotb_id];
                      if (identiteObservee.uid != membre.uid) {
                        lignes.push([identiteObservee, { uid: '?' }, { uid: '?' }, { uid: '?' }, { uid: '?' }, membre]);
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
                        <td class="${ colonnes[0] && colonnes[0].statusClass }">${ (colonnes[0] && colonnes[0].uid) || ''}</td>
                        <td class="${ colonnes[1] && colonnes[1].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[1] && colonnes[1].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[1] && colonnes[1].statusClass }">${ (colonnes[1] && colonnes[1].uid) || ''}</td>
                        <td class="${ colonnes[2] && colonnes[2].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[2] && colonnes[2].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[2] && colonnes[2].statusClass }">${ (colonnes[2] && colonnes[2].uid) || ''}</td>
                        <td class="${ colonnes[3] && colonnes[3].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[3] && colonnes[3].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[3] && colonnes[3].statusClass }">${ (colonnes[3] && colonnes[3].uid) || ''}</td>
                        <td class="${ colonnes[4] && colonnes[4].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[4] && colonnes[4].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[4] && colonnes[4].statusClass }">${ (colonnes[4] && colonnes[4].uid) || ''}</td>
                        <td class="${ colonnes[5] && colonnes[5].pendingCert ? 'isPendingCert' : '' }">${ (colonnes[5] && colonnes[5].uid) ? '<-' : ''}</td>
                        <td class="${ colonnes[5] && colonnes[5].statusClass }">${ (colonnes[5] && colonnes[5].uid) || ''}</td>
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
                        <th>Infinity</th>
                      </tr>
                      ${chemins}
                    </table>
                  `;
                }
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
                td.isSentry {
                  color: blue;
                }
                td.isPending {
                  color: orange;
                  font-weight: bold;
                }
                td.isMember {
                  color: black;
                }
                td.isPendingCert {
                  color: orange;
                  font-weight: bold;
                }
                td {
                  text-align: center;
                }
              </style>
              <script type="text/javascript">
              
                function onLoadedPage() {
                  var to = querySt("to");
                  var pending = querySt("pending") == 'on' ? 'checked' : '';
                  var mode = querySt("mode");
                  
                  document.getElementById('to').value = to || '';
                  document.getElementById('pending').checked = pending;
                  if (mode == "u2w") {
                    document.getElementById('modeu2w').checked = 'checked';
                  } else {
                    document.getElementById('modew2u').checked = 'checked';
                  }
                }
                
                function querySt(ji) {
  
                    var hu = window.location.search.substring(1);
                    var gy = hu.split("&");
                
                    for (i=0;i<gy.length;i++) {
                        ft = gy[i].split("=");
                        if (ft[0] == ji) {
                            return ft[1];
                        }
                    }
                }
              </script>
            </head>
            <body onload="onLoadedPage()">
              <h1>wotb explorer</h1>
              <form method="GET" action="/">
                <div>
                  <label for="to">Test UID:</label>
                  <input type="text" name="to" id="to">
                  <br>
                  <input type="checkbox" name="pending" id="pending">
                  <label for="pending">Include sandbox's data</label>
                  <br>
                  <input type="radio" name="mode" id="modew2u" value="w2u" checked="checked">See distance from WoT to User</div>
                  <input type="radio" name="mode" id="modeu2w" value="u2w">See distance from User to WoT</div>
                  <br>
                  <input type="submit"/>
                </div>
              </form>
              ${searchResult}
              <h2>Current sentries:</h2>
              ${sentriesHTML}
            </body>
          </html>
        `;
            wotb.clear();
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

function traduitCheminEnIdentites(chemins, dicoIdentites, mapPendingCerts) {
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
    return inverse.map((wotb_id, index) => {
      const obj = dicoIdentites[wotb_id];
      if (index > 0) {
        const to_wid = inverse[index - 1];
        const from_wid = inverse[index];
        const lien = [from_wid, to_wid].join('-');
        if (mapPendingCerts[lien]) {
          obj.pendingCert = true;
        }
      }
      return obj;
    });
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
