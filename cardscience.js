#!/usr/bin/env node
var util = require("util");

var csutil = require("./lib/util");

var cradle = require("cradle");

var zombie = require("zombie");

var url = require('url');

var base = require("./lib/models/base");
var card = require("./lib/models/card");

var nomnom = require("nomnom");

var Scraper = function() {
    var browser = new zombie.Browser({debug: true});
    browser.runScripts = false;

    // corner-case cards:
    // http://gatherer.wizards.com/Pages/Card/Details.aspx?multiverseid=205399
    // http://gatherer.wizards.com/Pages/Card/Details.aspx?multiverseid=96966
    // http://gatherer.wizards.com/Pages/Search/Default.aspx?name=+[pain]+[suffering]

    // http://gatherer.wizards.com/Pages/Search/Default.aspx?page=0&output=standard&special=true&format=%5B%22Standard%22%5D

    // TODO the "format" part of the query (which is basically
    // "legality"), is significant.  we want to remember that in our
    // database.  however, whenever we update, we'll have to be
    // mindful that cards we no longer see in that query will have to
    // be removed from that format set.

    // TODO the <img> tags inside the card text fields should be
    // distilled into semantic tags of some sort.  not necessarily
    // HTML tags.

    this.scrapePage = function(page_no, success, failure) {
        fetchurl = { protocol: "http",
                host: "gatherer.wizards.com",
                pathname: "/Pages/Search/Default.aspx",
                query: {
                    page: page_no,
                    output: "standard",
                    special: "true", // what's this for?
                    format: '["Standard"]'
                }
              };

        console.log("Starting scrape fetch...");
        browser.visit(url.format(fetchurl), function(err, browser, status) {
            if(err) {
                console.log("Shit, couldn't fetch page from Gatherer.");
                // TODO if it failed, try again at least a few times before emitting error
                throw(err.message);
            }

            var verifyElements = function(element) {
                if(element === undefined) {
                    throw new Error("Attempt to find an element failed!");
                }
                return element;
            }

            var card_item_table = verifyElements(browser.document.querySelector(".cardItemTable"));
            var card_items = verifyElements(card_item_table.querySelectorAll("tr.cardItem"));

            // TODO dang, with forEach() we can't process the items in
            // sequence, yet still wait on asynchronous things.  this
            // is useful mostly so we can handle errors.  with
            // eachWait(), we can do just that.  however, it means
            // that we really are processing things synchronously and
            // end up spending a lot of time waiting for each CouchDB
            // insert to complete (admittedly, I'm not sure how well
            // CouchDB parallelizes creation on a single instance on a
            // machine).  we could do even better if we ran all the
            // jobs simultaneously, but only returned once all of them
            // had completed.
            card_items.update().eachWait(function(card_item, each_done, each_error) {
                var card_info_elem = verifyElements(card_item.querySelector("div.cardInfo"));
                var set_versions_elem = verifyElements(card_item.querySelector("td.setVersions"));
                var set_hyperlink_elem = verifyElements(set_versions_elem.querySelector('div[id$="cardSetCurrent"] > a'));
                var mana_cost_elem = verifyElements(card_info_elem.querySelector("span.manaCost"));
                var mana_cost_img_elems = verifyElements(mana_cost_elem.querySelectorAll("img"));
                var mana_costs = {};
                // TODO this isn't good enough.
                // these are the formats:

                // TODO detect multipart cards:  the title is formatted like:
                // SideA // SideB (SideA)

                // Detect it if there's `//` in the title, and set _id
                // to be $id_$side.  however, even though they'll show
                // up separately in the query results page, their
                // share a MultiverseID.  We'll leave mid as the
                // original, although that will mean that the mid
                // field will no longer be guaranteed unique.

                // The new "innistrad" set apparently has a concept of
                // a double-sided card (seems silly to me, but there
                // it is).  We'll see how those appear on gatherer,
                // but my approach for dealing with composite cards
                // should apply to that as well.

                // in order to deal with these different types of
                // cards, it might be reasonable to have subcards
                // instead of separate cards.  this better reflects
                // the construction of the card, and returns
                // MultiverseID to its role of primary key.  these
                // subtypes could be called `facets`. For regular
                // cards, there would be one called `base`.  For
                // `//`-style dual cards, there would be two facets
                // named for the two subcards (alas, this involves a
                // bit of redundancy with the title, but alas there is
                // no other way to repeatably identify the facets.

                // It might be appropriate to add another field to
                // identify the nature of the compositing, and thus
                // the format of the keys used in as keys in the
                // facets hash.  There are the `//` split cards, the
                // Innistrad dual cards, and presumably other things.

                // how will updating work?  I do want to update the
                // documents in the DB, and not destroy them and
                // recreate them as I do now.  However, for the above
                // composite cards, I can't just naiively squish the
                // contents, because I will be updating in several
                // steps as I iterate over the HTML and encounter the
                // separate cardItems for each facet (since it's
                // Gatherer's approach to make seperate search result
                // items, even though they do still have the same MID)
                // this is awkward for deleting, because I don't want
                // to accrue removed things.  I could do it
                // heuristically, where I only delete things I know I
                // can.  Gross, though.  Better would be to have the
                // scrape job keep track of what cards its seen, and
                // then actually replacing any old contents with the
                // aggregated new contents.

                // * integer number, say, 1, 2, 8.  Also, for the
                //   benefit of another kind, assume English-text
                //   versions, such as One, Two, and so on) These are
                //   colorless.
                // * a name, say, Red, Blue, etc.
                // * either of the above appended with "or". These are 
                mana_cost_img_elems.update().forEach(function(mana_img) {
                    if(isNaN(mana_img.alt)) {
                        // it's a mana colour
                        var color_name = mana_img.alt.toLowerCase();
                        mana_costs[color_name] = mana_costs[color_name] || 0;
                        mana_costs[color_name]++;
                    } else {
                        // it's colorless
                        mana_costs["colourless"] = mana_costs["colourless"] || 0;
                        Number(mana_img.alt).times(function() {
                            mana_costs["colourless"]++;
                        });
                    }
                });
                // TODO assert that length of mana_cost_list matches converted_mana_cost

                var set_hyperlink = url.parse(set_hyperlink_elem.href, true);


                // usages of innerHTML bother me.  Entities and such
                // are not processed, but don't seem to occur (often?)
                // in the magic card titles
                var new_card = {
                    title: verifyElements(card_item.querySelector("span.cardTitle a")).innerHTML,
                    id: "mtg_card_" + set_hyperlink.query.multiverseid,
                    mid: set_hyperlink.query.multiverseid,
                    mana_cost: mana_costs,
                    converted_mana_cost: verifyElements(card_info_elem.querySelector("span.convertedManaCost")).innerHTML,
                };
                                               
                console.log(new_card.mid + ": " + new_card.title);
                // console.log(new_card);

                var createCard = function() {
                    card.newInstance(new_card);
                    new_card.save(function() {
                        console.log("Successfully saved card: " + new_card.mid);
                        each_done();
                    }, function(error) {
                        console.log("Unable to save card: " + error);
                        each_error();
                    });
                };
                
                card.find("mtg_card_" + new_card.mid, function(found_card) {
                    console.log("Card with multiverse ID '" + new_card.mid + "' exists already, deleting.");
                    found_card.destroy(function() {
                        // done
                        createCard();
                    }, function() {
                        // error
                        console.log("Unable to delete existing card, what the crap");
                        each_error();
                    });
                }, function(error) {
                    // card not existing, going to make one
                    createCard();
                });
            }.bind(this), function() {
                // done
                var page_links = browser.document.querySelector('div.pagingControls')
                
                var second_last = page_links.childNodes[page_links.childNodes.length - 1];

                if(second_last.tagName === "A") {
                    console.log("More to do!");
                    this.scrapePage(page_no + 1, success, failure);
                } else {
                    console.log("On last page!");
                    success();
                }
            }.bind(this), function() {
                throw new Error("Problem dealing with a card item.");
            });
        }.bind(this));
    };

    this.scrapePage(0);
};

var CardScience = function() {
    console.log("Welcome to CardScience.");
    var options = nomnom.opts({
        installdb : {
            abbr: "i",
            help: "Install design documents into CouchDB",
            flag: true
        }
    }).parseArgs();
    var connection = new cradle.Connection();
    var db = connection.database("cardscience");
    

    var initialize = function() {
        var scraper = new Scraper();
        base.init(db);

        
        if(options.installdb) {
            base.Base.updateAllDesignDocuments(function() {
                console.log("Updated all design docs successfully.");
                // now that data model is properly initialized, do initial loads from DB, etc
                process.exit(0);
            }.bind(this), function(e) {
                console.log("Problem updating design documents: " + e.reason);
                process.exit(-1);
            });
        }
    };

    db.exists(function(err, exists) {
        if(err) {
            console.log('error', "Yikes, problem connecting to CouchDB: " + err);
        } else if(exists) {
            console.log("Database is ready.");
            initialize();
        } else {
            console.log("Database does not yet exist, creating it.");
            db.create();
            initialize();
        }
    });
};

new CardScience(function() {
    // success
    console.log("Success!");
}, function() {
    // failure
    console.log("Problems fetching the pages, giving up.");
});
