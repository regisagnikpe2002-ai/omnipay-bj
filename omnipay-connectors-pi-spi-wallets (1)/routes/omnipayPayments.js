"use strict";
const router=require("express").Router();
const c=require("../controllers/connectorsController");
router.post("/receive",c.receive);
router.post("/pay",c.pay);
module.exports=router;
