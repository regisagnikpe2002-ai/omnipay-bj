"use strict";
const router=require("express").Router();
const c=require("../controllers/connectorsController");
router.post("/request-to-pay",c.piRequestToPay);
router.post("/aliases/resolve",c.piResolveAlias);
router.get("/payments/:id",c.piStatus);
module.exports=router;
